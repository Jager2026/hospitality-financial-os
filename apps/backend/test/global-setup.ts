import { PrismaClient } from "@prisma/client";
import { seedCurrencies, seedRbac } from "../prisma/seed";

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
//
// Sprint 12: delegates to `prisma/seed.ts`'s own `seedCurrencies`/`seedRbac` instead of maintaining
// a second, hand-copied Permission/Role/RolePermission matrix here — the previous copy had drifted
// stale (4 of 10 real Permissions, 3 of 4 real Roles, Owner missing 8 of its 10 real grants),
// invisible until Sprint 12's own E2E flow test became the first test to exercise the real
// JwtAuthGuard/PermissionsGuard DB-backed pipeline instead of hand-building AuthenticatedUser.
export async function setup(): Promise<void> {
  const prisma = new PrismaClient();
  await prisma.$connect();

  await seedCurrencies(prisma);
  await seedRbac(prisma);

  await prisma.$disconnect();
}
