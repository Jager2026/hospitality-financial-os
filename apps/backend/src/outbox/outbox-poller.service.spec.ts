import { randomUUID } from "node:crypto";
import { shiftServiceForTests } from "../../test/fixtures/shift-for-tests";
import Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LedgerService } from "../ledger/ledger.service";
import { PrismaService } from "../prisma/prisma.service";
import type { RestaurantService } from "../restaurant/restaurant.service";
import { StripeService } from "../stripe/stripe.service";
import { IndividualTipAllocationStrategy } from "../tip/individual-tip-allocation.strategy";
import { WalletProjectionService } from "../wallet/wallet-projection.service";
import { WebhooksService } from "../webhooks/webhooks.service";
import {
  ABANDON_UNDELIVERED_AFTER_MS,
  EMAIL_OUTBOX_EVENT_TYPE,
  type EmailOutboxService,
} from "../email/email-outbox.service";
import { PermanentRejection } from "../common/errors/permanent-rejection";
import { OutboxPollerService, retryDelayMs } from "./outbox-poller.service";

/** ADR-069. The poller gained a second dispatch target; this file is about the FIRST one. A handler
 * that throws on contact is the honest stub here — if the money path ever routes an event into the
 * email branch, these tests must fail loudly rather than pass with nothing having happened. */
function emailOutboxThatMustNotBeCalled(): EmailOutboxService {
  return {
    handle: async () => {
      throw new Error("the email handler must not be reached by a money-path event");
    },
  } as unknown as EmailOutboxService;
}

// Real database, real WalletProjectionService — ADR-024: this is the first test this file has
// ever had, because before Sprint 7 there was no real handler to dispatch to (EVENT_CATALOG.md).
// A stub PinoLogger avoids pulling in nestjs-pino's own DI wiring for a plain unit-style test.
const WEBHOOK_SECRET = "whsec_test_fake_secret_for_signing_only";

function signEvent(payload: object): { rawBody: Buffer; signature: string } {
  const raw = JSON.stringify(payload);
  const header = Stripe.webhooks.generateTestHeaderString({ payload: raw, secret: WEBHOOK_SECRET });
  return { rawBody: Buffer.from(raw), signature: header };
}

function buildEvent(type: string, dataObject: Record<string, unknown>) {
  return {
    id: `evt_test_${randomUUID()}`,
    object: "event",
    type,
    data: { object: dataObject },
    api_version: "2026-07-29.dahlia",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
  };
}

/**
 * ADR-085. A projection handler that fails the way a real one fails — transiently, and only for the
 * events a test nominates.
 *
 * **Why this had to be introduced, and what it replaced.** Every test in this file that needed "an
 * event that fails on every attempt" used to produce one by writing `journalEntryId:
 * "not-a-valid-uuid"` — a payload the poller rejects before it ever reaches a handler. That was a
 * fine way to make dispatch fail while failure had only one meaning. It has two now: such an event
 * is REJECTED on the first attempt and never reaches a second, so every assertion about backoff,
 * about attempt counts, and about the alert at five attempts would have been asserting something
 * that can no longer happen.
 *
 * **Why it delegates instead of throwing unconditionally, which is the part that was got wrong
 * first and is worth keeping written down.** The first version threw for every event. That turns
 * the poller into something that can never drain ANYTHING — so in a full parallel suite, where
 * other files are writing legitimate outbox rows the whole time, the head fills with events this
 * poller refuses to publish and the test's own event, sorting newest, is never reached. Three tests
 * failed that way and the symptom was `attempts` standing at 0: **the starvation this file now
 * tests for, reproduced accidentally inside the test harness.** Failing only the nominated
 * `journalEntryId`s keeps the poller a working poller for everything else.
 */
function walletProjectionFailingFor(
  prisma: PrismaService,
  failing: Set<string>,
): WalletProjectionService {
  const real = new WalletProjectionService(prisma);
  return {
    handleJournalEntryEvent: async (
      journalEntryId: string,
      tx: Parameters<WalletProjectionService["handleJournalEntryEvent"]>[1],
    ) => {
      if (failing.has(journalEntryId)) {
        throw new Error("simulated transient projection failure");
      }
      return real.handleJournalEntryEvent(journalEntryId, tx);
    },
  } as unknown as WalletProjectionService;
}

const fakeLogger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

// ADR-031/032: none of this file's first describe block's own tests drive any single event's
// attempts up to MAX_ATTEMPTS_BEFORE_ALERT (5), so AlertService.sendAlert() is never actually
// exercised by them regardless — a no-op stub is enough here. The dedicated "OutboxPollerService
// alerting" describe block below verifies the real call; AlertService's own fetch/URL/success/
// failure behavior is tested directly in alert.service.spec.ts (ADR-032 extracted it out of this
// class into its own shared service).
const fakeAlertServiceNoop = {
  sendAlert: () => Promise.resolve(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

// Same 30s reasoning as beforeAll's own drain loop below, applied to the individual tests too —
// verified by fact this session, not assumed from resemblance to a prior incident: a real
// unpublished-event backlog (measured directly via SQL, not guessed) plus real per-dispatch
// wall-clock cost pushed pollUntilSettled past Vitest's 5000ms default here, reproducibly, even
// with zero other test files running concurrently against the same database.
const BACKLOG_SAFE_TIMEOUT_MS = 30_000;

describe("OutboxPollerService (real database)", () => {
  const prisma = new PrismaService();
  let poller: OutboxPollerService;
  let walletProjection: WalletProjectionService;
  let webhooks: WebhooksService;

  beforeAll(async () => {
    await prisma.$connect();
    const stripe = new StripeService(
      {
        getOrThrow: (key: string) =>
          key === "STRIPE_WEBHOOK_SECRET"
            ? WEBHOOK_SECRET
            : key === "NODE_ENV"
              ? "test"
              : "sk_test_fake_never_called",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // ADR-038: StripeService now carries a boot-time credential probe. NODE_ENV is "test" above,
      // so the probe never runs here and never makes a network call — these two dependencies exist
      // only to satisfy the constructor.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { sendAlert: async () => undefined } as any,
      {
        setContext: () => undefined,
        info: () => undefined,
        error: () => undefined,
        warn: () => undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    );
    const ledger = new LedgerService(prisma, shiftServiceForTests(prisma));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeConfig = { getOrThrow: () => 100 } as any;
    const fakeRestaurantService = {} as RestaurantService;
    webhooks = new WebhooksService(
      prisma,
      stripe,
      ledger,
      fakeRestaurantService,
      fakeConfig,
      new IndividualTipAllocationStrategy(),
    );
    walletProjection = new WalletProjectionService(prisma);
    poller = new OutboxPollerService(
      prisma,
      walletProjection,
      // ADR-069: the second consumer. Throwing here is deliberate — every test in this file is
      // about the MONEY path, so an email handler being reached at all would be a defect, and a
      // stub that silently succeeded would hide it.
      emailOutboxThatMustNotBeCalled(),
      fakeLogger,
      fakeAlertServiceNoop,
    );

    // This local dev/test database has never had a real consumer before Sprint 7 — every
    // webhook-driven test run all session left its OutboxEvent rows unpublished, since nothing
    // ever called poll() against them. Best-effort, not "until empty": ledger.service.spec.ts's
    // own atomicity test permanently seeds an OutboxEvent with no journalEntryId (deliberately —
    // it's testing that the write lands in the same transaction as the Ledger write, nothing to
    // do with Wallet), which now fails fast and stays unpublished forever by design, so a
    // "drain to zero" loop would never terminate. A bounded pass here just clears the bulk of
    // legitimate backlog; each test below still confirms its OWN specific events settle via
    // pollUntilSettled, regardless of whatever permanent noise remains.
    for (let i = 0; i < 10; i++) {
      await poller.poll();
    }
  }, 30_000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedOrgRestaurant() {
    const org = await prisma.organization.create({ data: { name: "Outbox Poller Test Org" } });
    const restaurant = await prisma.restaurant.create({
      data: {
        organizationId: org.id,
        name: "Outbox Poller Test Restaurant",
        legalName: "Outbox Poller Test Restaurant UAB",
        companyNumber: `OP-${randomUUID()}`,
        vatNumber: `LT${randomUUID()}`,
        email: `restaurant-${randomUUID()}@example.com`,
        phone: "+37060000007",
        country: "LT",
        currency: "EUR",
        defaultCustomerLocale: "en",
        timezone: "Europe/Vilnius",
        address: "Test address",
        stripeAccountId: `acct_fake_${randomUUID()}`,
      },
    });
    return { org, restaurant };
  }

  async function seedWaiterMembership(organizationId: string, restaurantId: string) {
    const waiterRole = await prisma.role.findUniqueOrThrow({ where: { name: "Waiter" } });
    const user = await prisma.user.create({
      data: {
        email: `waiter-${randomUUID()}@example.com`,
        displayName: "Test Waiter",
        passwordHash: "not-a-real-hash",
        locale: "en",
      },
    });
    return prisma.membership.create({
      data: { userId: user.id, organizationId, restaurantId, roleId: waiterRole.id },
    });
  }

  async function seedPayment(
    restaurantId: string,
    amount: bigint,
    tipAmount: bigint,
    waiterMembershipId: string,
    processorPaymentId: string,
  ) {
    const key = `outbox-poll-test-key-${randomUUID()}`;
    await prisma.idempotencyKey.create({
      data: {
        key,
        endpointScope: "/payments",
        requestFingerprint: "test",
        status: "COMPLETED",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    return prisma.payment.create({
      data: {
        restaurantId,
        processor: "stripe",
        processorPaymentId,
        amount,
        tipAmount,
        waiterMembershipId,
        currency: "EUR",
        status: "PENDING",
        paymentMethod: "card",
        idempotencyKey: key,
      },
    });
  }

  // Bounded catch-up, not a bare single poll() call: a real, continuously-running dev DB can
  // always have a few unrelated events from another concurrently-running test file ahead of
  // this test's own in the queue (createdAt-ordered) — this reaches THIS test's own ids
  // regardless, the same way the real interval-driven poller eventually would.
  async function pollUntilSettled(ids: string[], maxIterations = 30): Promise<void> {
    for (let i = 0; i < maxIterations; i++) {
      const remaining = await prisma.outboxEvent.count({
        where: { id: { in: ids }, publishedAt: null },
      });
      if (remaining === 0) return;
      await poller.poll();
      // ADR-083: an event that has FAILED is not eligible again until its backoff expires, so a
      // tight poll loop would spin without retrying it. The first delay is `retryDelayMs(1)` =
      // 2s, and this waits it out in real time rather than faking the clock, because this block
      // also signs Stripe webhook events and those carry their own timestamp tolerance. Events
      // that never failed are unaffected: they settle on the first poll and the loop returns
      // before sleeping twice.
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  it(
    "poll() dispatches a real payment_captured/tip_allocated event pair to WalletProjectionService, marks published_at, and does NOT increment attempts on success — discriminating: the pre-Sprint-7 skeleton incremented attempts unconditionally, even on a successful dispatch",
    async () => {
      const { org, restaurant } = await seedOrgRestaurant();
      const waiterMembership = await seedWaiterMembership(org.id, restaurant.id);
      const piId = `pi_${randomUUID()}`;
      await seedPayment(restaurant.id, 2000n, 500n, waiterMembership.id, piId);

      const { rawBody, signature } = signEvent(
        buildEvent("payment_intent.succeeded", { id: piId, amount: 2000, currency: "eur" }),
      );
      await webhooks.handleEvent(rawBody, signature);

      const transaction = await prisma.transaction.findFirst({
        where: { payment: { processorPaymentId: piId } },
      });
      const entriesBefore = await prisma.journalEntry.findMany({
        where: { transactionId: transaction?.id },
      });
      const eventsBefore = await prisma.outboxEvent.findMany({
        where: { aggregateId: { in: entriesBefore.map((e) => e.id) } },
      });
      expect(eventsBefore).toHaveLength(2); // PAYMENT_CAPTURED + TIP_ALLOCATED
      expect(eventsBefore.every((e) => e.publishedAt === null)).toBe(true);
      expect(eventsBefore.every((e) => e.attempts === 0)).toBe(true);

      await pollUntilSettled(eventsBefore.map((e) => e.id));

      const eventsAfter = await prisma.outboxEvent.findMany({
        where: { id: { in: eventsBefore.map((e) => e.id) } },
      });
      expect(eventsAfter.every((e) => e.publishedAt !== null)).toBe(true);
      expect(eventsAfter.every((e) => e.attempts === 0)).toBe(true); // NOT incremented on success

      const wallet = await prisma.wallet.findUnique({
        where: { membershipId: waiterMembership.id },
      });
      expect(wallet?.availableBalance).toBe(500n); // the real effect: Wallet actually updated
    },
    BACKLOG_SAFE_TIMEOUT_MS,
  );

  it(
    "poll() does not re-process an already-published event on a second call",
    async () => {
      const { org, restaurant } = await seedOrgRestaurant();
      const waiterMembership = await seedWaiterMembership(org.id, restaurant.id);
      const piId = `pi_${randomUUID()}`;
      await seedPayment(restaurant.id, 1000n, 200n, waiterMembership.id, piId);

      const { rawBody, signature } = signEvent(
        buildEvent("payment_intent.succeeded", { id: piId, amount: 1000, currency: "eur" }),
      );
      await webhooks.handleEvent(rawBody, signature);

      const transaction = await prisma.transaction.findFirst({
        where: { payment: { processorPaymentId: piId } },
      });
      const entries = await prisma.journalEntry.findMany({
        where: { transactionId: transaction?.id },
      });
      const events = await prisma.outboxEvent.findMany({
        where: { aggregateId: { in: entries.map((e) => e.id) } },
      });

      await pollUntilSettled(events.map((e) => e.id));
      const walletAfterFirst = await prisma.wallet.findUnique({
        where: { membershipId: waiterMembership.id },
      });

      await poller.poll(); // second call — this test's own events already published, should be a no-op for them
      const walletAfterSecond = await prisma.wallet.findUnique({
        where: { membershipId: waiterMembership.id },
      });

      expect(walletAfterSecond?.availableBalance).toBe(walletAfterFirst?.availableBalance);
      expect(walletAfterSecond?.updatedAt.getTime()).toBe(walletAfterFirst?.updatedAt.getTime()); // not re-written
    },
    BACKLOG_SAFE_TIMEOUT_MS,
  );

  it(
    "a malformed event is REJECTED on its first and only attempt: abandoned_at is set, a reason is " +
      "recorded, and published_at stays null — ADR-085, and the pair for it is the transient-crash " +
      "test below, where the identical dispatch failure must NOT be terminal",
    async () => {
      const badEvent = await prisma.outboxEvent.create({
        data: {
          aggregateType: "JournalEntry",
          aggregateId: randomUUID(),
          eventType: "journal_entry.payment_captured",
          payload: { journalEntryId: "not-a-valid-uuid" }, // refers to no JournalEntry at all
        },
      });

      for (let i = 0; i < 20; i++) {
        const current = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: badEvent.id } });
        if (current.attempts > 0) break;
        await poller.poll();
      }

      const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: badEvent.id } });
      expect(after.attempts, "the rejection was not counted as an attempt").toBe(1);
      expect(
        after.publishedAt,
        "an abandoned event must never be marked published — it was not published, it was given up on",
      ).toBeNull();
      expect(
        after.abandonedAt,
        "a payload referring to no work was queued for retry forever",
      ).not.toBeNull();
      expect(after.abandonedReason).toContain("journalEntryId");
    },
    BACKLOG_SAFE_TIMEOUT_MS,
  );

  it(
    "IMPLEMENTATION_PLAN.md Sprint 12 chaos test: a transient crash mid-dispatch (simulating the " +
      "worker dying mid-run, not a permanently malformed event) leaves the crashed event " +
      "unpublished and its projection un-applied — retried on a later poll, it resumes and " +
      "completes exactly once, never losing or duplicating the Wallet effect",
    async () => {
      const { org, restaurant } = await seedOrgRestaurant();
      const waiterMembership = await seedWaiterMembership(org.id, restaurant.id);
      const piId = `pi_${randomUUID()}`;
      await seedPayment(restaurant.id, 1500n, 300n, waiterMembership.id, piId);

      const { rawBody, signature } = signEvent(
        buildEvent("payment_intent.succeeded", { id: piId, amount: 1500, currency: "eur" }),
      );
      await webhooks.handleEvent(rawBody, signature);

      const transaction = await prisma.transaction.findFirst({
        where: { payment: { processorPaymentId: piId } },
      });
      const entries = await prisma.journalEntry.findMany({
        where: { transactionId: transaction?.id },
      });
      const myEntryIds = new Set(entries.map((e) => e.id));
      const events = await prisma.outboxEvent.findMany({
        where: { aggregateId: { in: entries.map((e) => e.id) } },
      });
      expect(events.length).toBeGreaterThan(0);

      // Targets the crash at THIS test's own journalEntryId specifically (throwing exactly once,
      // then delegating to the real implementation for every other call) rather than "whichever
      // event this poll() happens to dispatch first" — the dev database is shared with whatever
      // else is running concurrently (the same reason pollUntilSettled exists at all, per this
      // file's own beforeAll comment), so a queue-position-dependent trigger would be flaky by
      // construction. This makes the simulated crash deterministic regardless of what else is in
      // the queue.
      const originalHandle = walletProjection.handleJournalEntryEvent.bind(walletProjection);
      let crashed = false;
      const crashSpy = vi
        .spyOn(walletProjection, "handleJournalEntryEvent")
        .mockImplementation(async (journalEntryId, tx) => {
          if (!crashed && myEntryIds.has(journalEntryId)) {
            crashed = true;
            throw new Error("simulated worker crash mid-dispatch");
          }
          return originalHandle(journalEntryId, tx);
        });

      await poller.poll();
      expect(crashed).toBe(true); // sanity: the simulated crash actually fired during this poll

      const afterCrash = await prisma.outboxEvent.findMany({
        where: { id: { in: events.map((e) => e.id) } },
      });
      const crashedEvent = afterCrash.find((e) => e.attempts === 1 && e.publishedAt === null);
      // Real proof the crash rolled back cleanly, not partially: outbox-poller.service.ts wraps
      // handleJournalEntryEvent + the published_at write in one Prisma $transaction, so a throw
      // inside the projection must leave BOTH un-committed, exactly like a real process crash
      // between them would (nothing left half-applied, matching ADR-002's own reasoning for why
      // the Ledger's own deferred trigger runs INSIDE the write transaction, not after it).
      expect(crashedEvent).toBeDefined();

      crashSpy.mockRestore(); // every subsequent call runs the real handleJournalEntryEvent again

      await pollUntilSettled(events.map((e) => e.id));

      const afterRetry = await prisma.outboxEvent.findMany({
        where: { id: { in: events.map((e) => e.id) } },
      });
      expect(afterRetry.every((e) => e.publishedAt !== null)).toBe(true); // resumed, not stuck

      const walletAfterRetry = await prisma.wallet.findUnique({
        where: { membershipId: waiterMembership.id },
      });
      expect(walletAfterRetry?.availableBalance).toBe(300n); // exactly the real tip — not lost

      // One further poll, now that everything for this test is already published, must not
      // double-apply anything — the "not duplicating" half of the DoD, not just "not losing."
      await poller.poll();
      const walletAfterExtraPoll = await prisma.wallet.findUnique({
        where: { membershipId: waiterMembership.id },
      });
      expect(walletAfterExtraPoll?.availableBalance).toBe(300n);
    },
    BACKLOG_SAFE_TIMEOUT_MS,
  );
});

// ADR-031/032: OutboxPollerService's own responsibility is just calling AlertService.sendAlert()
// at the right moment, with the right message — the fetch/URL/success/failure mechanics of
// actually delivering it are AlertService's own concern now (alert.service.spec.ts), extracted
// out of this class once PaymentReconciliationService became a second real consumer. A separate
// describe block (own PrismaService/WalletProjectionService/OutboxPollerService per test) rather
// than reusing the shared `poller` above, which is deliberately built with a no-op AlertService so
// the first describe block's own tests stay unaffected by this one.
describe("OutboxPollerService alerting (ADR-031/032)", () => {
  const prisma = new PrismaService();
  /** The `journalEntryId`s this block wants to fail; everything else projects for real. */
  const failingIds = new Set<string>();
  let walletProjection: WalletProjectionService;

  beforeAll(async () => {
    await prisma.$connect();
    // ADR-085. This block drives ONE event's attempts past the alert threshold, which is only
    // possible for an event that keeps being retried — so the failure it needs is a transient one,
    // produced in the handler rather than by a payload the poller now rejects outright. Scoped to
    // this block's own events, so its pollers still drain everything else and its own event is
    // actually reached.
    walletProjection = walletProjectionFailingFor(prisma, failingIds);
  });

  // ADR-083. Only `Date` is faked, never timers: Prisma's own connection and query timeouts are
  // real `setTimeout`s, and stopping those would hang a test against a real database rather than
  // fail it. Faking `Date` alone is enough, because the backoff is written and read as a JS date
  // on both sides — `next_attempt_at = Date.now() + delay` on failure, `lte: new Date()` in the
  // query.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // The real dev database is shared with every other concurrently-running test file/worker in a
  // full suite run (this file's own pollUntilSettled comments already document this) — poll()
  // always dispatches EVERY unpublished row, not just the one this test seeded, so some unrelated
  // stray row from elsewhere can coincidentally cross the exact attempts===5 boundary while THIS
  // test's poller happens to be polling. Counting raw sendAlert calls would be flaky by
  // construction; scoping to calls whose message actually references this test's own event id is
  // immune to that noise, the same "scope to this test's own ids" discipline this file already
  // applies everywhere else.
  function callsForEvent(sendAlert: ReturnType<typeof vi.fn>, eventId: string): unknown[] {
    return sendAlert.mock.calls.filter((call) => (call[0] as string).includes(eventId));
  }

  // A WELL-FORMED event whose handler fails every time (see walletProjectionThatFailsTransiently)
  // — it passes payload validation, reaches the handler, and fails there, deterministically, on
  // every poll. That is what this block needs: an event that keeps being retried, so one event's
  // own `attempts` can cross MAX_ATTEMPTS_BEFORE_ALERT.
  //
  // `randomUUID()` is a valid UUID that matches no JournalEntry, which under ADR-085 is a
  // successful no-op rather than a failure — so the failure genuinely comes from the stubbed
  // handler and from nothing else.
  async function seedFailingEvent() {
    const journalEntryId = randomUUID();
    failingIds.add(journalEntryId);
    return prisma.outboxEvent.create({
      data: {
        aggregateType: "JournalEntry",
        aggregateId: randomUUID(),
        eventType: "journal_entry.payment_captured",
        payload: { journalEntryId },
      },
    });
  }

  // Same bounded-catch-up reasoning as this file's own pollUntilSettled: a shared, continuously
  // used dev database can have unrelated unpublished rows ahead of this test's own in the
  // createdAt-ordered queue, so this polls until OUR event's own attempts count reaches the
  // target, not just once.
  async function pollUntilAttempts(
    poller: OutboxPollerService,
    id: string,
    minAttempts: number,
    maxIterations = 40,
  ): Promise<void> {
    for (let i = 0; i < maxIterations; i++) {
      const current = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
      if (current.attempts >= minAttempts) return;
      await poller.poll();
      // ADR-083. Driving one event to five attempts used to take five polls and eight seconds of
      // nothing; it now takes 2 + 4 + 8 + 16 = 30 seconds of waiting, which no test should spend.
      // The clock moves instead of the row: rewriting `next_attempt_at` directly would step around
      // the eligibility rule that half of these assertions depend on.
      vi.setSystemTime(new Date(Date.now() + retryDelayMs(current.attempts + 1)));
    }
  }

  it(
    "calls AlertService.sendAlert() exactly once, on the poll that crosses the threshold, with the event id and attempt count in the message — and does NOT call it again on later retries of the same still-stuck event",
    async () => {
      const sendAlert = vi.fn().mockResolvedValue(undefined);
      const poller = new OutboxPollerService(
        prisma,
        walletProjection,
        emailOutboxThatMustNotBeCalled(),
        fakeLogger,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { sendAlert } as any,
      );
      const event = await seedFailingEvent();

      await pollUntilAttempts(poller, event.id, 5);
      // Keep polling well past the threshold — discriminating: a naive implementation that fires
      // on every attempt >= threshold (instead of exactly attempts === threshold) would call
      // sendAlert again here too, re-alerting the same stuck event every poll.
      await pollUntilAttempts(poller, event.id, 8);

      const calls = callsForEvent(sendAlert, event.id);
      expect(calls).toHaveLength(1);
      const [message, context] = calls[0] as [string, { eventId: string }];
      expect(message).toContain(event.id);
      expect(message).toContain("5 times");
      expect(context).toEqual({ eventId: event.id });
    },
    BACKLOG_SAFE_TIMEOUT_MS,
  );

  it(
    "a failing AlertService.sendAlert() (rejected) does not crash poll() and does not stop the underlying event's own retry accounting — discriminating: AlertService already swallows its own delivery failures internally, but OutboxPollerService's own call site must not assume that and blow up if it didn't",
    async () => {
      const sendAlert = vi.fn().mockRejectedValue(new Error("simulated AlertService failure"));
      const poller = new OutboxPollerService(
        prisma,
        walletProjection,
        emailOutboxThatMustNotBeCalled(),
        fakeLogger,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { sendAlert } as any,
      );
      const event = await seedFailingEvent();

      for (let i = 0; i < 8; i++) {
        await expect(poller.poll()).resolves.toBeUndefined();
        // ADR-083: same reason as pollUntilAttempts — without moving the clock this loop would
        // poll eight times and retry once, and the assertion below would be about the backoff
        // rather than about a throwing AlertService.
        vi.setSystemTime(new Date(Date.now() + retryDelayMs(i + 1)));
      }

      const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(after.attempts).toBeGreaterThanOrEqual(5);
    },
    BACKLOG_SAFE_TIMEOUT_MS,
  );
});

// ADR-069 — the poller now routes by eventType, and this block is the proof that the routing is
// additive: the money path is unchanged, and only an email event reaches the email handler.
//
// Own PrismaService and own poller per test, for the same reason the alerting block above has
// them: the shared `poller` at the top is deliberately built with a handler that throws on contact.
describe("OutboxPollerService routing by eventType (ADR-069)", () => {
  const prisma = new PrismaService();

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const fakeLoggerLocal = {
    setContext: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  /** Reaches into the private dispatch path the only way a test honestly can: through poll(), by
   * seeding exactly one unpublished row and giving the poller handlers that record contact. */
  function pollerRecording() {
    // walletArgs, not just a count: poll() dispatches EVERY unpublished row in this shared dev
    // database, not only the row a test seeded — this file's own pollUntilSettled comments already
    // record that. A global counter therefore cannot say anything about one event, and an
    // assertion that it is zero is an assertion about whatever else the suite happened to leave
    // behind. What the arguments CAN prove is that nothing malformed ever reached the projection.
    const seen = { wallet: 0, email: 0, walletArgs: [] as unknown[] };
    const walletStub = {
      handleJournalEntryEvent: async (journalEntryId: unknown) => {
        seen.wallet += 1;
        seen.walletArgs.push(journalEntryId);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const emailStub = {
      handle: async (event: { id: string }) => {
        seen.email += 1;
        await prisma.outboxEvent.update({
          where: { id: event.id },
          data: { publishedAt: new Date() },
        });
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const poller = new OutboxPollerService(prisma, walletStub, emailStub, fakeLoggerLocal, {
      sendAlert: async () => undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    return { poller, seen };
  }

  it(
    "an email request reaches the EMAIL handler and never the wallet projection — and a " +
      "journal-entry event reaches the WALLET projection and never the email handler: two rows, " +
      "two destinations, neither implementation passing if the branch were dropped",
    async () => {
      const { poller, seen } = pollerRecording();

      const emailEvent = await prisma.outboxEvent.create({
        data: {
          aggregateType: "EmailDelivery",
          aggregateId: randomUUID(),
          eventType: EMAIL_OUTBOX_EVENT_TYPE,
          payload: { to: "a@b.invalid", subject: "s", text: "t" },
        },
      });
      const moneyEvent = await prisma.outboxEvent.create({
        data: {
          aggregateType: "JournalEntry",
          aggregateId: randomUUID(),
          eventType: "journal_entry.payment_captured",
          payload: { journalEntryId: randomUUID() },
        },
      });

      await poller.poll();

      // The email row went to the email handler.
      expect(seen.email).toBeGreaterThanOrEqual(1);
      expect(
        (await prisma.outboxEvent.findUniqueOrThrow({ where: { id: emailEvent.id } })).publishedAt,
      ).not.toBeNull();

      // The money row went to the wallet projection and was published by the poller's own
      // transaction — the path that existed before this change, byte for byte.
      expect(seen.wallet).toBeGreaterThanOrEqual(1);
      expect(
        (await prisma.outboxEvent.findUniqueOrThrow({ where: { id: moneyEvent.id } })).publishedAt,
      ).not.toBeNull();
    },
    BACKLOG_SAFE_TIMEOUT_MS,
  );

  it(
    "a malformed money event still fails fast — the guard that stops WalletProjectionService " +
      "recomputing every Membership in the database is untouched by the new branch",
    async () => {
      const { poller, seen } = pollerRecording();
      const malformed = await prisma.outboxEvent.create({
        data: {
          aggregateType: "JournalEntry",
          aggregateId: randomUUID(),
          eventType: "journal_entry.payment_captured",
          payload: {},
        },
      });

      await poller.poll();

      const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: malformed.id } });
      expect(after.publishedAt).toBeNull();
      expect(after.attempts).toBeGreaterThanOrEqual(1);
      // The property the guard actually protects, stated in a way other rows cannot disturb:
      // WalletProjectionService is never handed anything but a real journal entry id. Without the
      // guard the poller passes this event's missing journalEntryId straight through as
      // `undefined`, and Prisma reads that as "omit this filter" — recomputing EVERY Membership's
      // balance in the database. That is the failure this asserts against.
      expect(seen.walletArgs.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    },
    BACKLOG_SAFE_TIMEOUT_MS,
  );
});

// ADR-083 — the backoff, and where finality actually lives. Every case here names the
// implementation it rejects, because the two wrong versions are both plausible: a retry with no
// backoff (what this repository had for three sprints) and an attempt-count ceiling applied to
// every event type alike (what the constant's old comment claimed existed).
describe("OutboxPollerService retry backoff and finality (ADR-083)", () => {
  const prisma = new PrismaService();
  /** The `journalEntryId`s this block wants to fail; everything else projects for real. */
  const failingIds = new Set<string>();
  let poller: OutboxPollerService;

  beforeAll(async () => {
    await prisma.$connect();
    // ADR-085. Every "failing money event" in this block must fail TRANSIENTLY: the whole block
    // is about a schedule of retries, and a rejected event has no schedule — it is concluded on its
    // first attempt. The failure therefore lives in the handler, not in the payload.
    poller = new OutboxPollerService(
      prisma,
      walletProjectionFailingFor(prisma, failingIds),
      emailOutboxThatMustNotBeCalled(),
      fakeLogger,
      fakeAlertServiceNoop,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Moves this test's frozen clock past the moment a row was inserted.
   *
   * **Why it is needed, and why leaving it out produced a test that passed for the wrong reason.**
   * `next_attempt_at` defaults to `now()` — the DATABASE's clock, which keeps running while
   * `vi.useFakeTimers` holds this process's `Date` still. A row inserted a few milliseconds after
   * the freeze therefore carries a `next_attempt_at` a few milliseconds in the *future* relative to
   * the `new Date()` the poller puts in its query, and is not selected at all.
   *
   * The first version of this block had no such nudge. Two tests failed outright — and the third,
   * the one asserting an abandoned email is never retried, **passed**: it expects the event not to
   * be selected, and it was not selected, for a reason that had nothing to do with ADR-075. A green
   * assertion resting on clock skew is worse than a red one, because nothing about it looks wrong.
   */
  function advancePastInsert(): void {
    vi.setSystemTime(new Date(Date.now() + 1_000));
  }

  /** A well-formed id this block's handler will refuse — used by the rows built inline below. */
  function failingId(): string {
    const id = randomUUID();
    failingIds.add(id);
    return id;
  }

  /** Well-formed, and failing deterministically inside the handler on every attempt, so what is
   *  being measured is the schedule rather than the failure.
   *
   *  It used to carry `journalEntryId: "not-a-valid-uuid"`, which was the same thing until ADR-085
   *  gave that payload a different meaning: a malformed payload is now REJECTED on the first
   *  attempt, so there would be no second attempt for any of these tests to measure. */
  async function seedTransientlyFailingMoneyEvent(createdAt?: Date) {
    const journalEntryId = randomUUID();
    failingIds.add(journalEntryId);
    return prisma.outboxEvent.create({
      data: {
        aggregateType: "JournalEntry",
        aggregateId: randomUUID(),
        eventType: "journal_entry.payment_captured",
        payload: { journalEntryId },
        ...(createdAt ? { createdAt } : {}),
      },
    });
  }

  // ── The regression these two exist for (ADR-083 amendment) ──────────────────────────────────
  //
  // The first version of the backoff filtered `next_attempt_at <= new Date()`. The left side is
  // written by the DATABASE (`DEFAULT now()`); the right side is the APPLICATION's clock. Those are
  // two clocks, and on the machine this was found on the database ran **5 ms ahead** — so an event
  // created and polled within that window was invisible to its own poller. It made the ADR-069
  // routing tests fail deterministically in isolation while the full file passed about one run in
  // three, because a longer run put more milliseconds between the insert and the poll.
  //
  // The pair below does not depend on the skew of whoever runs it: it SETS a future
  // `next_attempt_at` explicitly, so the two cases differ by one field and by nothing else.

  it(
    "an event that has never been attempted is due immediately, whatever the clocks say — " +
      "discriminating: the first version compared a database-written timestamp against the " +
      "application's clock, and skipped anything newer than the skew between them",
    async () => {
      const event = await prisma.outboxEvent.create({
        data: {
          aggregateType: "JournalEntry",
          aggregateId: randomUUID(),
          eventType: "journal_entry.payment_captured",
          payload: { journalEntryId: failingId() },
          // Five seconds ahead — far beyond any real skew, so the assertion is about the RULE
          // ("never attempted means due") rather than about this machine's clocks.
          nextAttemptAt: new Date(Date.now() + 5_000),
        },
      });

      await poller.poll();

      const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(
        after.attempts,
        "a brand-new event waited for a clock instead of being dispatched",
      ).toBe(1);
    },
    BACKLOG_SAFE_TIMEOUT_MS,
  );

  it(
    "an event that HAS been attempted still waits for its backoff — the other half, without which " +
      "the fix above would simply have switched the backoff off",
    async () => {
      const event = await prisma.outboxEvent.create({
        data: {
          aggregateType: "JournalEntry",
          aggregateId: randomUUID(),
          eventType: "journal_entry.payment_captured",
          payload: { journalEntryId: failingId() },
          attempts: 3,
          nextAttemptAt: new Date(Date.now() + 60_000),
        },
      });

      await poller.poll();

      const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(after.attempts, "a failing event was retried before its backoff expired").toBe(3);
    },
    BACKLOG_SAFE_TIMEOUT_MS,
  );

  it("the delay doubles and then stops doubling", () => {
    // The shape, stated once so the behavioural tests below do not have to restate it. A version
    // without the cap would grow to 2^n and pass every other assertion in this file.
    expect(retryDelayMs(1)).toBe(2_000);
    expect(retryDelayMs(2)).toBe(4_000);
    expect(retryDelayMs(3)).toBe(8_000);
    expect(retryDelayMs(9)).toBe(5 * 60 * 1000);
    expect(retryDelayMs(5_293), "an event at 5,293 attempts must not be waiting for years").toBe(
      5 * 60 * 1000,
    );
  });

  it(
    "a failing event is not retried immediately, and each gap is longer than the one before — " +
      "discriminating: with no backoff every poll retries it, which is how one event reached 5,293 attempts",
    async () => {
      const event = await seedTransientlyFailingMoneyEvent();
      advancePastInsert();

      await poller.poll();
      const first = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(first.attempts).toBe(1);
      const firstGap = first.nextAttemptAt.getTime() - Date.now();
      expect(firstGap, "the first retry was scheduled in the past").toBeGreaterThan(0);

      // THE HALF THAT REJECTS THE OLD IMPLEMENTATION: polling again straight away must do nothing
      // at all to this event. Before this change the attempt count would already be 2.
      await poller.poll();
      const immediate = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(immediate.attempts, "a failing event was retried before its backoff expired").toBe(1);

      vi.setSystemTime(new Date(Date.now() + firstGap));
      await poller.poll();
      const second = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(second.attempts).toBe(2);
      const secondGap = second.nextAttemptAt.getTime() - Date.now();

      expect(secondGap, "the interval between attempts did not grow").toBeGreaterThan(firstGap);
    },
    BACKLOG_SAFE_TIMEOUT_MS,
  );

  it(
    "an email event past the ADR-075 window is never selected again — finality for email is a " +
      "WINDOW, and it is the poller's query that enforces it",
    async () => {
      // The email handler in this block throws on contact, so "never selected" is asserted by the
      // absence of an explosion as well as by the attempt count standing still.
      const stale = await prisma.outboxEvent.create({
        data: {
          aggregateType: "MembershipInvitation",
          aggregateId: randomUUID(),
          eventType: EMAIL_OUTBOX_EVENT_TYPE,
          payload: { to: "nobody@example.invalid", subject: "s", text: "t" },
          createdAt: new Date(Date.now() - ABANDON_UNDELIVERED_AFTER_MS - 1000),
        },
      });
      advancePastInsert();

      await expect(poller.poll()).resolves.toBeUndefined();

      const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: stale.id } });
      expect(after.attempts, "an abandoned email event was attempted again").toBe(0);
      expect(
        after.publishedAt,
        "an abandoned email event must never be marked published",
      ).toBeNull();
    },
    BACKLOG_SAFE_TIMEOUT_MS,
  );

  it(
    "a money event of the same age IS still retried — the asymmetry is deliberate, and giving up " +
      "on a Wallet projection has never been decided",
    async () => {
      // THE DISCRIMINATING PAIR with the test above: same age, opposite answer. An implementation
      // that applied one ceiling to every event type would pass that test and fail this one, and
      // the damage would be a Wallet left permanently wrong rather than an email not sent.
      const old = await seedTransientlyFailingMoneyEvent(
        new Date(Date.now() - ABANDON_UNDELIVERED_AFTER_MS - 1000),
      );
      advancePastInsert();

      await poller.poll();

      const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: old.id } });
      expect(after.attempts, "a money event was abandoned by age, which nothing has decided").toBe(
        1,
      );
    },
    BACKLOG_SAFE_TIMEOUT_MS,
  );
});

// ADR-085 — the queue's second exit, and the property the Founder named as the falsification:
// a head made of rows that can never resolve must not stop fresh work from being done.
//
// Own PrismaService and own poller, same reason as the blocks above.
describe("OutboxPollerService abandonment (ADR-085)", () => {
  const prisma = new PrismaService();
  let poller: OutboxPollerService;

  const BATCH_SIZE = 50; // mirrors the constant in the service; the ballast below must exceed it

  /** Every ballast id this block's own poller has alerted about — see the assertion that reads it.
   *  It belongs to THIS poller's stub, so nothing another worker's poller does can reach it. */
  const alertsForBallast: string[] = [];
  const ballastIds = new Set<string>();

  beforeAll(async () => {
    await prisma.$connect();
    poller = new OutboxPollerService(
      prisma,
      new WalletProjectionService(prisma),
      emailOutboxThatMustNotBeCalled(),
      fakeLogger,
      {
        sendAlert: (_message: string, context?: { eventId?: string }) => {
          if (context?.eventId && ballastIds.has(context.eventId)) {
            alertsForBallast.push(context.eventId);
          }
          return Promise.resolve();
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    );
  });

  // Same reasoning as the reconciliation block's own teardown: this test seeds more than one full
  // batch on purpose, and owns what it seeded. Folded into the disconnect hook rather than added as
  // a second afterAll, so nothing depends on which order two teardowns run in.
  const seeded: string[] = [];

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { id: { in: seeded } } });
    await prisma.$disconnect();
  });

  /** One event the poller can never dispatch: its payload refers to no JournalEntry. */
  async function seedUnprocessable(createdAt: Date) {
    return prisma.outboxEvent.create({
      data: {
        aggregateType: "JournalEntry",
        aggregateId: randomUUID(),
        eventType: "journal_entry.payment_captured",
        payload: { journalEntryId: "not-a-valid-uuid" },
        createdAt,
      },
    });
  }

  /** Records a seeded id so the teardown above can remove exactly this test's own rows. */
  function track<T extends { id: string }>(row: T): T {
    seeded.push(row.id);
    return row;
  }

  it(
    "a head of unprocessable rows is seen once and never again, and a fresh event behind it is " +
      "published — THE HALF THAT REJECTS THE OLD IMPLEMENTATION is the attempt count: with no " +
      "terminal state those same rows are re-selected every time their backoff expires, forever, " +
      "and they are ordered ahead of everything newer by construction",
    async () => {
      // Sixty — more than one batch — dated far enough back that nothing else in this shared
      // database sorts ahead of them, so the batch really is made of this test's own rows.
      const base = Date.now() - 60 * 24 * 60 * 60 * 1000;
      const ballast: string[] = [];
      for (let i = 0; i < BATCH_SIZE + 10; i++) {
        const row = track(await seedUnprocessable(new Date(base + i * 1000)));
        ballast.push(row.id);
        ballastIds.add(row.id);
      }
      // One event immediately behind the ballast and ahead of everything else. Without a terminal
      // state this is the row that waits: it is the 61st oldest, and the batch is 50.
      const fresh = track(
        await prisma.outboxEvent.create({
          data: {
            aggregateType: "JournalEntry",
            aggregateId: randomUUID(),
            eventType: "journal_entry.payment_captured",
            // A valid UUID matching no JournalEntry: handleJournalEntryEvent finds no membership
            // lines and succeeds as a no-op, which is a normal outcome (wallet-projection.service.ts)
            // and exactly what makes this row's publication a statement about the QUEUE rather than
            // about the projection.
            payload: { journalEntryId: randomUUID() },
            createdAt: new Date(base + (BATCH_SIZE + 10) * 1000),
          },
        }),
      );

      // Two polls: the first takes 50 of the ballast, the second the remaining 10 and the fresh
      // event. Both are needed with OR without the fix — a first pass over rows nobody has looked
      // at costs the same either way. The difference is everything after it.
      await poller.poll();
      await poller.poll();

      const published = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: fresh.id } });
      expect(
        published.publishedAt,
        "a fresh event behind a head of unprocessable rows was never dispatched",
      ).not.toBeNull();

      const abandoned = await prisma.outboxEvent.count({
        where: { id: { in: ballast }, abandonedAt: { not: null } },
      });
      expect(abandoned, "unprocessable rows were left in the queue").toBe(ballast.length);

      // The steady state of a real database: every one of those rows is due again, because hours
      // have passed. This is not an artificial condition — it is the condition the dev database
      // was measured in (every stuck row eligible, next_attempt_at long past).
      await prisma.outboxEvent.updateMany({
        where: { id: { in: ballast } },
        data: { nextAttemptAt: new Date(Date.now() - 60_000) },
      });

      // THE HALF THAT REJECTS THE OLD IMPLEMENTATION, and it is asserted through the ALERT rather
      // than through `attempts`, for a reason worth keeping.
      //
      // The first version compared the sum of `attempts` across the ballast before and after this
      // poll. That is a statement about the ROWS, and the rows are shared: `critical-flow.e2e.spec.ts`
      // imports this same service and runs `poll()` in a loop, in another worker, against the same
      // database. Its batch is selected before this test abandons anything and its per-row
      // increments land afterwards — the missing claim step this class's own comment describes,
      // arriving as a flaky assertion. Measured: the sum moved by 11 on one full-gate run and by
      // nothing on three others.
      //
      // `sendAlert` belongs to THIS poller's own stub, so nothing another worker does can reach it.
      // A rejectable row that were selected again would be abandoned again, and `abandon()` alerts
      // unconditionally — so the absence of an alert naming a ballast id is a statement about this
      // poller's own batch, which is the thing under test.
      alertsForBallast.length = 0;

      await poller.poll();

      expect(
        alertsForBallast,
        "rows the queue had already given up on were selected again, which is the defect itself",
      ).toEqual([]);
    },
    120_000,
  );

  it(
    "a TRANSIENT failure is never abandoned — it counts, backs off and stays in the queue, which " +
      "is the discriminating pair for the test above: the same dispatch throws, the same row " +
      "shape, and the opposite answer, because this one refers to real work",
    async () => {
      const journalEntryId = randomUUID();
      const transientPoller = new OutboxPollerService(
        prisma,
        walletProjectionFailingFor(prisma, new Set([journalEntryId])),
        emailOutboxThatMustNotBeCalled(),
        fakeLogger,
        fakeAlertServiceNoop,
      );
      const event = track(
        await prisma.outboxEvent.create({
          data: {
            aggregateType: "JournalEntry",
            aggregateId: randomUUID(),
            eventType: "journal_entry.payment_captured",
            payload: { journalEntryId },
          },
        }),
      );

      for (let i = 0; i < 40; i++) {
        const current = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
        if (current.attempts > 0) break;
        await transientPoller.poll();
      }

      const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(after.attempts, "a transient failure was not counted").toBe(1);
      expect(
        after.abandonedAt,
        "a transient handler failure was treated as terminal — this is how a real Wallet projection would be silently dropped",
      ).toBeNull();
      expect(
        after.nextAttemptAt.getTime(),
        "a transient failure did not schedule a retry",
      ).toBeGreaterThan(after.createdAt.getTime());
    },
    120_000,
  );
});

// ADR-087 — what the phrase `operational alert` means, decided.
//
// **One environment, three causes, three answers.** That is the whole point: nothing in this block
// changes NODE_ENV, and nothing in the implementation consults it. A rule that silenced the channel
// outside production would pass a test that set NODE_ENV and would do nothing for the first
// restaurant, which is the failure this decision exists to avoid.
describe("OutboxPollerService alert semantics (ADR-087)", () => {
  const prisma = new PrismaService();
  const seeded: string[] = [];

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { id: { in: seeded } } });
    await prisma.$disconnect();
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** An email handler that fails one specific way, so the CAUSE is the only variable here. */
  function emailHandlerThrowing(err: unknown): EmailOutboxService {
    return {
      handle: async () => {
        throw err;
      },
    } as unknown as EmailOutboxService;
  }

  function pollerWith(emailOutbox: EmailOutboxService, sendAlert: ReturnType<typeof vi.fn>) {
    return new OutboxPollerService(
      prisma,
      new WalletProjectionService(prisma),
      emailOutbox,
      fakeLogger,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { sendAlert } as any,
    );
  }

  async function seedEmailEvent() {
    const row = await prisma.outboxEvent.create({
      data: {
        aggregateType: "MembershipInvitation",
        aggregateId: randomUUID(),
        eventType: EMAIL_OUTBOX_EVENT_TYPE,
        payload: { to: "nobody@example.invalid", subject: "s", text: "t" },
      },
    });
    seeded.push(row.id);
    // The same reason the ADR-083 block needs it: `next_attempt_at` defaults to the DATABASE clock,
    // which keeps running while the test process's `Date` is frozen.
    vi.setSystemTime(new Date(Date.now() + 1_000));
    return row;
  }

  /** Bounded catch-up on THIS event, the discipline the rest of this file already uses. */
  async function pollUntil(
    poller: OutboxPollerService,
    id: string,
    done: (row: { attempts: number; abandonedAt: Date | null }) => boolean,
    maxIterations = 20,
  ): Promise<void> {
    for (let i = 0; i < maxIterations; i++) {
      const current = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
      if (done(current)) return;
      await poller.poll();
      vi.setSystemTime(new Date(Date.now() + retryDelayMs(current.attempts + 1)));
    }
  }

  it(
    "EXPECTED: a policy refusal concludes the event and raises no alert — an implementation that " +
      "alerts here is the one that fills the channel with the system working correctly",
    async () => {
      const sendAlert = vi.fn().mockResolvedValue(undefined);
      const poller = pollerWith(
        emailHandlerThrowing(
          PermanentRejection.expected("Refusing to send outside production (NODE_ENV=test)."),
        ),
        sendAlert,
      );
      const event = await seedEmailEvent();

      await pollUntil(poller, event.id, (row) => row.abandonedAt !== null);

      const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(
        after.abandonedAt,
        "an event that can never be sent was left in the queue",
      ).not.toBeNull();
      expect(after.abandonedReason).toContain("Refusing to send");
      expect(
        sendAlert.mock.calls.filter((c) => (c[0] as string).includes(event.id)),
        "expected behaviour raised an operational alert",
      ).toHaveLength(0);
    },
    BACKLOG_SAFE_TIMEOUT_MS,
  );

  it(
    "INCIDENT: a rejection that is NOT expected concludes the event AND alerts — the " +
      "discriminating pair for the test above: same method, same conclusion, opposite answer, and " +
      "the only difference is why",
    async () => {
      const sendAlert = vi.fn().mockResolvedValue(undefined);
      const poller = pollerWith(
        emailHandlerThrowing(new PermanentRejection("the payload refers to no real work")),
        sendAlert,
      );
      const event = await seedEmailEvent();

      await pollUntil(poller, event.id, (row) => row.abandonedAt !== null);

      const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(after.abandonedAt).not.toBeNull();
      expect(
        sendAlert.mock.calls.filter((c) => (c[0] as string).includes(event.id)),
        "an incident was concluded silently, which is ADR-045's invisible failure",
      ).toHaveLength(1);
    },
    BACKLOG_SAFE_TIMEOUT_MS,
  );

  it(
    "PROVIDER FAILURE: a real outage is not concluded and still reaches the channel at the " +
      "threshold — in the SAME environment as the silent case above, which is what makes the " +
      "distinction one of cause rather than one of NODE_ENV",
    async () => {
      const sendAlert = vi.fn().mockResolvedValue(undefined);
      const poller = pollerWith(
        emailHandlerThrowing(new Error("Resend responded 500: Internal Server Error")),
        sendAlert,
      );
      const event = await seedEmailEvent();

      await pollUntil(poller, event.id, (row) => row.attempts >= 5);

      const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(
        after.abandonedAt,
        "a provider outage concluded the event — a real invitation would have been dropped",
      ).toBeNull();
      expect(after.attempts).toBeGreaterThanOrEqual(5);
      expect(
        sendAlert.mock.calls.filter((c) => (c[0] as string).includes(event.id)),
        "a provider outage was silent",
      ).toHaveLength(1);
    },
    BACKLOG_SAFE_TIMEOUT_MS,
  );
});
