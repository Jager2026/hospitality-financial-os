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

  await reportAccumulatedRows(prisma);

  await prisma.$disconnect();
}

/**
 * One line, printed unconditionally, blocking nothing.
 *
 * The development database is shared across runs and never cleaned: every suite run leaves its
 * rows behind, and services that read a batch of them eventually read hundreds. Three failures in
 * one sprint were caused by that accumulation, in two different spec files, and each cost real
 * time to attribute — because the numbers had to be gone and looked for.
 *
 * A threshold that FAILED the run was considered and rejected. Any limit would be arbitrary, a
 * long debugging session would legitimately cross it, and the fix people would reach for is
 * raising the limit — which is `CLAUDE.md`'s rubber-stamp degradation, arriving by the front door.
 *
 * So: instrument, do not gate. The morning's diagnosis was only found because a number happened to
 * appear in a failure message (`Number of calls: 460`). This puts that number at the top of every
 * run instead, where nobody has to remember the rule to benefit from it. Nothing to bypass,
 * nothing to tune, and it stays useful even once the suite cleans up after itself
 * (`IMPLEMENTATION_PLAN.md`, Deferred).
 */
async function reportAccumulatedRows(prisma: PrismaClient): Promise<void> {
  const [payments, outbox, unpublished] = await Promise.all([
    prisma.payment.count(),
    prisma.outboxEvent.count(),
    prisma.outboxEvent.count({ where: { publishedAt: null } }),
  ]);

  // The unpublished count is called out against BATCH_SIZE specifically, because that is the one
  // number here with a hard edge rather than a vague "too many". OutboxPollerService takes 50 rows
  // per poll, oldest first, so once older debris fills a batch, the poller specs' own fresh events
  // never enter one and the specs fail for a reason that has nothing to do with the code.
  //
  // The suite leaves permanently-unpublished events behind every run — deliberately malformed rows
  // from the tests that assert the retry path, which by construction can never publish. How many
  // varies: 0 after a reset, then 45, 10 and 61 across observed runs, because some events do get
  // published and the debris depends on ordering. **No per-run rate is claimed here; only that it
  // accumulates and that 50 is where it starts to bite** — a failure was seen at 61.
  const POLLER_BATCH_SIZE = 50;
  const starving = unpublished >= POLLER_BATCH_SIZE;

  console.log(
    `[db] accumulated rows — payments: ${payments}, outbox: ${outbox} (${unpublished} unpublished)` +
      (starving
        ? ` — WARNING: unpublished >= the poller's batch size of ${POLLER_BATCH_SIZE}, so outbox ` +
          `specs will starve. Run: pnpm run db:reset`
        : `. A failure that appears only after repeated runs is a stale-data suspect first. ` +
          `Reset with: pnpm run db:reset`),
  );
}
