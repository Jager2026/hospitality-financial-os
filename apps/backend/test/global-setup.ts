import { PrismaClient } from "@prisma/client";

// Vitest's `globalSetup` runs exactly ONCE, in its own process, before any test file's worker
// starts — unlike `setupFiles` (./setup.ts), which runs once PER FILE. This is the right tool for
// seeding shared reference data that multiple spec files depend on.
//
// Previously, 7 files each independently `upsert`-ed Currency("EUR") in their own `beforeAll`,
// and 4 more did the same for shared Role/Permission/RolePermission rows. This produced a real,
// intermittent CI failure (`P2002` unique-constraint violation) — not a Postgres weakness in
// `INSERT ... ON CONFLICT DO UPDATE` (which is designed to handle exactly this), but because
// Prisma's `upsert()` does not compile to a single atomic `INSERT ... ON CONFLICT` statement on
// this version/provider. Confirmed directly by enabling Prisma's query-event log and reading the
// actual SQL: `BEGIN` / `SELECT ... WHERE code = $1` / `INSERT ...` / `COMMIT` — a manual
// check-then-act sequence inside a transaction. Two `beforeAll` hooks landing close enough
// together under Vitest's parallel-file execution could both SELECT, see no row yet, and both
// attempt INSERT — a genuine race, not a rare fluke of the database engine.
//
// Seeding once here removes the race by construction: every spec file that used to `upsert` these
// rows now does a plain `findUniqueOrThrow` instead, which never writes and so cannot race.
export async function setup(): Promise<void> {
  const prisma = new PrismaClient();
  await prisma.$connect();

  await prisma.currency.upsert({
    where: { code: "EUR" },
    update: {},
    create: { code: "EUR", exponent: 2, name: "Euro" },
  });

  const permissions = [
    { name: "restaurant.create", description: "Create a new Restaurant" },
    { name: "restaurant.edit", description: "Edit Restaurant details and settings" },
    { name: "membership.manage", description: "Edit or disable an existing Membership" },
    { name: "payments.manage", description: "View and manage payment activity" },
  ];

  for (const permission of permissions) {
    await prisma.permission.upsert({
      where: { name: permission.name },
      update: {},
      create: permission,
    });
  }

  const roles = [
    { name: "Owner", description: "Full control of an Organization and its Restaurants" },
    { name: "Manager", description: "Day-to-day operational control of one Restaurant" },
    { name: "Waiter", description: "Restaurant staff member" },
  ];

  for (const role of roles) {
    await prisma.role.upsert({
      where: { name: role.name },
      update: {},
      create: role,
    });
  }

  const rolePermissions = [
    { role: "Owner", permission: "restaurant.create" },
    { role: "Owner", permission: "restaurant.edit" },
    { role: "Manager", permission: "membership.manage" },
    { role: "Manager", permission: "payments.manage" },
  ];

  for (const { role, permission } of rolePermissions) {
    const [roleRow, permissionRow] = await Promise.all([
      prisma.role.findUniqueOrThrow({ where: { name: role } }),
      prisma.permission.findUniqueOrThrow({ where: { name: permission } }),
    ]);
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: roleRow.id, permissionId: permissionRow.id } },
      update: {},
      create: { roleId: roleRow.id, permissionId: permissionRow.id },
    });
  }

  await prisma.$disconnect();
}
