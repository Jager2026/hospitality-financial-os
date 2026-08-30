import { PrismaClient } from "@prisma/client";

// ISO 4217 reference data (ADR-001). Not exhaustive — a curated set covering: EUR (required,
// ADR-012's launch currency), other major currencies a restaurant guest might reasonably pay
// with, and a deliberate sample of non-2-exponent currencies (JPY: 0, BHD: 3) proving the
// exponent-lookup mechanism ADR-001 exists for actually matters, not just EUR/USD where every
// exponent happens to be 2.
const CURRENCIES = [
  { code: "EUR", exponent: 2, name: "Euro" },
  { code: "USD", exponent: 2, name: "US Dollar" },
  { code: "GBP", exponent: 2, name: "British Pound" },
  { code: "CHF", exponent: 2, name: "Swiss Franc" },
  { code: "SEK", exponent: 2, name: "Swedish Krona" },
  { code: "NOK", exponent: 2, name: "Norwegian Krone" },
  { code: "DKK", exponent: 2, name: "Danish Krone" },
  { code: "PLN", exponent: 2, name: "Polish Zloty" },
  { code: "CZK", exponent: 2, name: "Czech Koruna" },
  { code: "RON", exponent: 2, name: "Romanian Leu" },
  { code: "JPY", exponent: 0, name: "Japanese Yen" },
  { code: "KRW", exponent: 0, name: "South Korean Won" },
  { code: "BHD", exponent: 3, name: "Bahraini Dinar" },
  { code: "KWD", exponent: 3, name: "Kuwaiti Dinar" },
];

// DATABASE.md names the four MVP roles ("Owner · Manager · Waiter · Administrator · future
// Accountant · future Auditor") and gives example Permissions ("Create Restaurant, Edit
// Restaurant, Invite Membership, View Reports, Manage Payments, Configure Tips, Export Data,
// Manage Roles") but never states the actual Role -> Permission grants — DATABASE.md's
// RolePermission rule only says the mapping must live in data, not what the data should be.
// ASSUMPTION, flagged for Founder review (same treatment as Sprint 0's enum-value assumptions):
// Owner and Administrator get every Permission; Manager gets day-to-day operational Permissions
// but not restaurant.create/delete or roles.manage; Waiter gets none of these (a waiter's own
// Wallet/Tips views aren't gated by this Permission set in MVP scope).
const PERMISSIONS = [
  { name: "restaurant.create", description: "Create a new Restaurant" },
  { name: "restaurant.edit", description: "Edit Restaurant details and settings" },
  { name: "restaurant.delete", description: "Soft-delete a Restaurant" },
  { name: "membership.invite", description: "Invite a new Membership" },
  { name: "membership.manage", description: "Edit or disable an existing Membership" },
  { name: "reports.view", description: "View restaurant reports and analytics" },
  { name: "payments.manage", description: "View and manage payment activity" },
  { name: "tips.configure", description: "Configure tip presets" },
  { name: "data.export", description: "Export transaction/report data" },
  { name: "roles.manage", description: "Manage Role/Permission assignments" },
] as const;

const ALL_PERMISSIONS = PERMISSIONS.map((p) => p.name);
const MANAGER_PERMISSIONS = [
  "restaurant.edit",
  "membership.invite",
  "membership.manage",
  "reports.view",
  "payments.manage",
  "tips.configure",
  "data.export",
];

const ROLES: Array<{
  name: string;
  description: string;
  permissions: readonly string[];
  /** ADR-044: true = ours to grant, never offered to a Restaurant. */
  platformOnly?: boolean;
}> = [
  {
    name: "Owner",
    description: "Full control of an Organization and its Restaurants",
    permissions: ALL_PERMISSIONS,
  },
  {
    name: "Administrator",
    description: "Platform-level administrator",
    permissions: ALL_PERMISSIONS,
    // ADR-044. The description already said "platform-level"; nothing enforced it. Any Owner
    // could grant this Role through POST /memberships, which validated only that the id existed.
    platformOnly: true,
  },
  {
    name: "Manager",
    description: "Day-to-day operational control of one Restaurant",
    permissions: MANAGER_PERMISSIONS,
  },
  { name: "Waiter", description: "Restaurant staff member", permissions: [] },
];

// Exported (Sprint 12) so test/global-setup.ts can seed the exact same Permission/Role/
// RolePermission matrix real deployments get, instead of maintaining its own hand-copied subset —
// a second, independently-edited copy of this matrix is exactly the "two numbers that could drift
// apart" failure shape this project has already extracted shared code to avoid elsewhere
// (restaurant-ledger-window.util.ts, restaurant-reachability.util.ts). Found stale by exactly that
// drift: global-setup.ts had 4 of 10 Permissions, 3 of 4 Roles, and granted Owner only 2 of its 10
// real Permissions — invisible until now because every existing test builds AuthenticatedUser by
// hand, bypassing the real JwtAuthGuard/PermissionsGuard DB-backed pipeline entirely; Sprint 12's
// own E2E flow test is the first to go through it for real.
export async function seedCurrencies(prisma: PrismaClient): Promise<void> {
  for (const currency of CURRENCIES) {
    await prisma.currency.upsert({
      where: { code: currency.code },
      create: currency,
      update: { exponent: currency.exponent, name: currency.name },
    });
  }
  console.log(`Seeded ${CURRENCIES.length} currencies.`);
}

export async function seedRbac(prisma: PrismaClient): Promise<void> {
  for (const permission of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { name: permission.name },
      create: permission,
      update: { description: permission.description },
    });
  }

  for (const role of ROLES) {
    const roleRow = await prisma.role.upsert({
      where: { name: role.name },
      // platformOnly is in BOTH create and update deliberately: an existing deployment already
      // has these rows, so leaving it out of update would mean the column stayed false in
      // production while being true in a fresh database — the flag would be correct only where it
      // was never needed (ADR-044).
      create: {
        name: role.name,
        description: role.description,
        platformOnly: role.platformOnly ?? false,
      },
      update: { description: role.description, platformOnly: role.platformOnly ?? false },
    });

    const permissionRows = await prisma.permission.findMany({
      where: { name: { in: [...role.permissions] } },
    });

    for (const permission of permissionRows) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: roleRow.id, permissionId: permission.id } },
        create: { roleId: roleRow.id, permissionId: permission.id },
        update: {},
      });
    }
  }

  // Reconcile, rather than only add. Until this existed the loop above was the whole mechanism,
  // and it could only ever grant: removing a Permission from a Role in this file changed nothing
  // on a database that already had the row. **A permission granted once stayed granted forever**,
  // and the file would go on describing a restriction that was not in force — the same shape as
  // ADR-044's `platformOnly` flag, which shipped as code and never reached production data.
  //
  // Every revocation is printed by name. This is the only operation here that destroys state, and
  // a count would let a wrong matrix pass as a number.
  for (const row of await findStaleGrants(prisma)) {
    console.log(`  REVOKING ${row.role} -> ${row.permission}`);
    await prisma.rolePermission.delete({
      where: { roleId_permissionId: { roleId: row.roleId, permissionId: row.permissionId } },
    });
  }

  console.log(`Seeded ${PERMISSIONS.length} permissions and ${ROLES.length} roles.`);
}

export interface StaleGrant {
  role: string;
  permission: string;
  roleId: string;
  permissionId: string;
}

/**
 * Every `RolePermission` row the matrix above does not intend — read-only, and exported so the
 * command-line entry point can show an operator what a run would take away *before* it takes it.
 * `seedRbac` and that preview therefore compute the same set from the same code; a second
 * implementation of "what counts as stale" is the drift this whole area exists to prevent.
 *
 * Deliberately narrow, and the narrowness is the safety mechanism:
 *
 *   * Only `RolePermission` join rows. Never a `Permission` (deleting one cascades to every Role
 *     and breaks code that names it) and never a `Role` (Memberships point at it).
 *   * Only Roles named in ROLES. A Role this file does not define was created by something else,
 *     and the seed cannot know what it would be revoking. None exist today — production holds
 *     exactly these four — so the limit costs nothing now and bounds the blast radius later.
 */
export async function findStaleGrants(prisma: PrismaClient): Promise<StaleGrant[]> {
  const stale: StaleGrant[] = [];

  for (const role of ROLES) {
    const roleRow = await prisma.role.findUnique({ where: { name: role.name } });
    if (!roleRow) continue; // Nothing seeded yet: nothing can be stale.

    const permissionRows = await prisma.permission.findMany({
      where: { name: { in: [...role.permissions] } },
    });
    const intendedIds = permissionRows.map((p) => p.id);

    const rows = await prisma.rolePermission.findMany({
      // An empty intended set means "this Role should hold nothing", which has to delete every row
      // rather than none. Written as two explicit branches instead of relying on how Prisma treats
      // `notIn: []` — a claim about someone else's code that would be load-bearing here, in the
      // destructive branch, and this project has already paid for two of those (ADR-031, fourth).
      where:
        intendedIds.length > 0
          ? { roleId: roleRow.id, permissionId: { notIn: intendedIds } }
          : { roleId: roleRow.id },
      include: { permission: true },
    });

    stale.push(
      ...rows.map((r) => ({
        role: role.name,
        permission: r.permission.name,
        roleId: r.roleId,
        permissionId: r.permissionId,
      })),
    );
  }

  return stale;
}

/**
 * ADR-046 addendum. The seed can now revoke permissions, and for the moment it lives in the worst
 * of the three possible states: **the mechanism exists, nothing runs it, and nothing warns the
 * first person who does.** Someone running `pnpm db:seed` by hand "to apply the changes" would
 * perform a privileged operation without knowing it was one.
 *
 * So a run that would revoke something stops and says what, instead of doing it. This is a
 * confirmation gate, not a block: `--allow-revocations` (or `SEED_ALLOW_REVOCATIONS=1`) proceeds.
 * An accidental run cannot revoke silently; a deliberate one is one flag away.
 *
 * Gating the SCRIPT and not `seedRbac()` itself is the important part. The function stays a plain
 * library call for `test/global-setup.ts` and the specs, which create and revoke rows constantly
 * and must not be prompted. Only the human-facing entry point asks.
 *
 * A flag rather than an interactive prompt, and the reason is about the decision that is still
 * open: if the seed is ever added to a deploy, an interactive prompt would hang it with no stdin,
 * whereas the flag has to be written into `railway.backend.json` — where it is visible, reviewed,
 * and unmistakably a choice that "the seed may revoke on every deploy". The gate shapes that
 * decision instead of pre-empting it.
 *
 * Its limit, stated so it is not mistaken for the answer: once the flag is added to automation it
 * is permanent and silent thereafter. **This stops accidental revocation. It does not decide
 * whether the seed should be authoritative** — that is still an open ADR.
 */
async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const allowed =
    process.argv.includes("--allow-revocations") || process.env.SEED_ALLOW_REVOCATIONS === "1";

  try {
    // Before any write, including currencies: a run that is going to be refused should not have
    // half-applied something first.
    const planned = await findStaleGrants(prisma);

    if (planned.length > 0 && !allowed) {
      console.error(
        `\nThis seed run would REVOKE ${planned.length} permission grant(s):\n` +
          planned.map((p) => `  - ${p.role} -> ${p.permission}`).join("\n") +
          `\n\nNothing has been changed. If that is intended, re-run with --allow-revocations ` +
          `(or SEED_ALLOW_REVOCATIONS=1).\nIf it is not, the matrix in prisma/seed.ts disagrees ` +
          `with this database — reconcile the file, not the flag.\n`,
      );
      process.exitCode = 1;
      return;
    }

    await seedCurrencies(prisma);
    await seedRbac(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

// Guards the auto-run so importing seedCurrencies/seedRbac from global-setup.ts doesn't also
// trigger this file's own standalone `main()` as an import side effect.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
