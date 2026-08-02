import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

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

const ROLES: Array<{ name: string; description: string; permissions: readonly string[] }> = [
  {
    name: "Owner",
    description: "Full control of an Organization and its Restaurants",
    permissions: ALL_PERMISSIONS,
  },
  {
    name: "Administrator",
    description: "Platform-level administrator",
    permissions: ALL_PERMISSIONS,
  },
  {
    name: "Manager",
    description: "Day-to-day operational control of one Restaurant",
    permissions: MANAGER_PERMISSIONS,
  },
  { name: "Waiter", description: "Restaurant staff member", permissions: [] },
];

async function seedCurrencies(): Promise<void> {
  for (const currency of CURRENCIES) {
    await prisma.currency.upsert({
      where: { code: currency.code },
      create: currency,
      update: { exponent: currency.exponent, name: currency.name },
    });
  }
  console.log(`Seeded ${CURRENCIES.length} currencies.`);
}

async function seedRbac(): Promise<void> {
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
      create: { name: role.name, description: role.description },
      update: { description: role.description },
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
  console.log(`Seeded ${PERMISSIONS.length} permissions and ${ROLES.length} roles.`);
}

async function main(): Promise<void> {
  await seedCurrencies();
  await seedRbac();
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
