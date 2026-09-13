import { PrismaClient } from "@prisma/client";
import { assertLocalDatabase } from "../prisma/database-locality";
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

  const concluded = await concludeUndeliverableEmails(prisma);
  if (concluded > 0) {
    console.log(
      `[db] concluded ${concluded} undeliverable email event${concluded === 1 ? "" : "s"} left by ` +
        `earlier runs — EmailService refuses to send outside production, so none of them could ever publish`,
    );
  }

  const swept = await sweepStuckTestPayments(prisma);
  console.log(
    `[db] swept ${swept.swept} stuck PENDING payment${swept.swept === 1 ? "" : "s"} left by earlier runs` +
      (swept.kept > 0
        ? ` — kept ${swept.kept} with a Ledger entry or a Tip behind them, which a sweep must never delete`
        : ""),
  );
  await reportAccumulatedRows(prisma);

  await prisma.$disconnect();
}

/**
 * ADR-086. Concludes the `email.send_requested` events earlier runs left unpublished.
 *
 * **The rule is a fact about this environment, not about the rows.** `EmailService.send` refuses
 * outright unless `NODE_ENV === "production"` — a deliberate decision with its own comment, so the
 * e2e suite cannot make live calls to Resend with a placeholder key. Every email event written
 * outside production is therefore **unpublishable by construction**: not old, not named like a
 * fixture, not merely stuck. It cannot succeed here, which is exactly what `PermanentRejection`
 * means, and ADR-085 already built the right way to record that.
 *
 * **So it marks rather than deletes**, and the distinction is ADR-075's: the row is the trace of a
 * send that was decided on, and removing it would destroy the record while leaving the recipient's
 * address one table over in `EmailDelivery` anyway. `abandoned_at` takes it out of the queue and
 * `abandoned_reason` says why, which is all that was needed.
 *
 * **Why it is here at all**, since ADR-085 concluded the unusable money events and this work's first
 * draft said the outbox needed no sweep: that claim rested on 16 eligible rows, and 16 was a
 * snapshot rather than a property. Email events fail, back off, and become eligible again in waves,
 * so a heavy session pushes the eligible count back over `OutboxPollerService`'s batch of 50 — it
 * was 51 on the run that exposed this, and the poller's own alerting spec lost its event behind
 * them. ADR-075's twenty-four-hour window does end it, but a day is longer than an afternoon.
 *
 * @param onlyEventIds narrows the candidates, used only by `harness-sweep.spec.ts` — calling the
 *   unrestricted version from inside a running suite would conclude the email events of every spec
 *   executing in parallel beside it.
 */
export async function concludeUndeliverableEmails(
  prisma: PrismaClient,
  onlyEventIds?: string[],
): Promise<number> {
  await assertLocalDatabase(
    prisma,
    "the test harness concludes email events that no environment but production could ever send",
  );

  const result = await prisma.outboxEvent.updateMany({
    where: {
      eventType: "email.send_requested",
      publishedAt: null,
      abandonedAt: null,
      ...(onlyEventIds ? { id: { in: onlyEventIds } } : {}),
    },
    data: {
      abandonedAt: new Date(),
      abandonedReason:
        "Left unpublished by an earlier test run. EmailService refuses to send outside production, " +
        "so this event could never have been delivered from this environment (ADR-086).",
    },
  });

  return result.count;
}

/**
 * ADR-086. Removes the `PENDING` Payment rows a previous run left behind, **before** this one
 * starts.
 *
 * ## Why the harness does this and not the specs
 *
 * Measured on 2026-09-13: a full backend suite leaves **+17 stuck PENDING payments**, 16 of them
 * with no Transaction at all. `PaymentReconciliationService` selects the oldest 100, so from an
 * empty database the sixth run crosses the bound and five reconciliation tests fail on rows that
 * have nothing to do with the code under test. Reproduced on `main` at 102 rows before this was
 * written, not inferred from the arithmetic.
 *
 * ADR-085 gave both queues a way to conclude a row that can never succeed, and deliberately did not
 * touch these: under a spec's own fake Stripe they answer `requires_payment_method`, which is
 * honestly non-terminal. They are not a product defect. They are litter.
 *
 * **Two spec files could clean up after themselves — twelve cannot, and two of them could not
 * anyway.** `permission-scope.e2e.spec.ts` and `critical-flow.e2e.spec.ts` drive the real HTTP
 * pipeline, so the Payment is created by `PaymentService` inside the request and the spec never
 * sees its id. Any design where the author of a spec has to remember something is a design that
 * works until the thirteenth spec, and the thirteenth spec is always the one written in a hurry.
 * So the cleanup is a property of the harness: nothing to remember, nothing to import, and it
 * covers rows no spec could have registered.
 *
 * ## Why BEFORE the run rather than in a teardown
 *
 * ADR-082's finding, reused rather than rediscovered: **a teardown does not run on a killed or
 * crashed run**, and those are exactly the runs that leave the most behind. Cleaning at the start
 * means the sweep has already happened by the time anything can go wrong with it.
 *
 * ## What it deletes, and why this is a structural rule rather than a matcher
 *
 * Not by age, and not by any naming convention — an allow list by another name is a file somebody
 * edits to make the build green, and a fixture-name matcher rots the moment a fixture is renamed.
 * Two shapes, both of which the PRODUCT cannot produce:
 *
 *   1. **A `PENDING` Payment with no Transaction.** The product creates one only in the seconds
 *      between a waiter presenting the terminal and a guest paying. Nobody is doing that at the
 *      instant a test suite starts, and a developer who was can start it again.
 *   2. **A `PENDING` Payment whose Transaction has no JournalEntry and no Tip.** In the product a
 *      Transaction is written by the `payment_intent.succeeded` handler, on the same path that
 *      posts the Ledger and sets the Payment `SUCCEEDED`. A completed Transaction with no Ledger
 *      behind it, over a Payment still `PENDING`, is a row a fixture assembled by hand. All 16 of
 *      those in the development database were measured to have exactly zero of each.
 *
 * **Anything with a JournalEntry or a Tip behind it is left alone and counted**, because that is
 * financial history and no test-harness convenience is worth deleting it. If that number ever grows,
 * it is telling you something a sweep must not answer.
 *
 * It deletes rows it did not create, and that is stated plainly rather than hidden: it is a rule
 * about a development database, not about this run's own rows. `assertLocalDatabase` is what keeps
 * that sentence true.
 *
 * @param onlyPaymentIds narrows the candidates to these ids **in addition to** every rule above,
 *   never instead of one. The production caller passes nothing; `harness-sweep.spec.ts` passes its
 *   own rows, because calling the real unrestricted sweep from inside a running suite would delete
 *   the in-flight payments of every spec executing in parallel beside it. What the narrowing cannot
 *   prove is the `status: "PENDING"` filter — so that spec seeds a SUCCEEDED payment of its own and
 *   asserts it survives, which proves it directly rather than by inspection.
 */
export async function sweepStuckTestPayments(
  prisma: PrismaClient,
  onlyPaymentIds?: string[],
): Promise<{ swept: number; kept: number }> {
  await assertLocalDatabase(
    prisma,
    "the test harness removes stuck PENDING payments left by previous runs",
  );

  const pending = await prisma.payment.findMany({
    where: { status: "PENDING", ...(onlyPaymentIds ? { id: { in: onlyPaymentIds } } : {}) },
    select: {
      id: true,
      idempotencyKey: true,
      transaction: {
        select: {
          id: true,
          tip: { select: { id: true } },
          _count: { select: { journalEntries: true } },
        },
      },
    },
  });

  const sweepable = pending.filter(
    (p) =>
      p.transaction === null ||
      (p.transaction._count.journalEntries === 0 && p.transaction.tip === null),
  );
  const kept = pending.length - sweepable.length;

  if (sweepable.length > 0) {
    const paymentIds = sweepable.map((p) => p.id);
    const transactionIds = sweepable
      .map((p) => p.transaction?.id)
      .filter((id): id is string => id !== undefined);

    // Order is forced by the foreign keys and is worth stating: Transaction points at Payment, and
    // Payment points at IdempotencyKey, so the chain is deleted from the far end inwards.
    await prisma.$transaction([
      prisma.transaction.deleteMany({ where: { id: { in: transactionIds } } }),
      prisma.payment.deleteMany({ where: { id: { in: paymentIds } } }),
      prisma.idempotencyKey.deleteMany({
        where: { key: { in: sweepable.map((p) => p.idempotencyKey) } },
      }),
    ]);
  }

  return { swept: sweepable.length, kept };
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
