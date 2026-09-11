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
    "a malformed event fails, increments attempts, and leaves published_at null — proves the retry path is real, not just the success path",
    async () => {
      const badEvent = await prisma.outboxEvent.create({
        data: {
          aggregateType: "JournalEntry",
          aggregateId: randomUUID(),
          eventType: "journal_entry.payment_captured",
          payload: { journalEntryId: "not-a-valid-uuid" }, // Postgres will reject this as a UUID filter
        },
      });

      for (let i = 0; i < 20; i++) {
        const current = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: badEvent.id } });
        if (current.attempts > 0) break;
        await poller.poll();
      }

      const after = await prisma.outboxEvent.findUnique({ where: { id: badEvent.id } });
      expect(after?.publishedAt).toBeNull();
      expect(after?.attempts).toBe(1);
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
  let walletProjection: WalletProjectionService;

  beforeAll(async () => {
    await prisma.$connect();
    walletProjection = new WalletProjectionService(prisma);
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

  // A deliberately, permanently malformed event (no valid journalEntryId) — same technique as the
  // "malformed event" test above — fails dispatch() deterministically on every single poll, with
  // no dependency on webhook/payment scaffolding, which is all this describe block needs to drive
  // one event's own `attempts` past MAX_ATTEMPTS_BEFORE_ALERT.
  async function seedFailingEvent() {
    return prisma.outboxEvent.create({
      data: {
        aggregateType: "JournalEntry",
        aggregateId: randomUUID(),
        eventType: "journal_entry.payment_captured",
        payload: { journalEntryId: "not-a-valid-uuid" },
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
  let poller: OutboxPollerService;

  beforeAll(async () => {
    await prisma.$connect();
    poller = new OutboxPollerService(
      prisma,
      new WalletProjectionService(prisma),
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

  /** Permanently malformed on purpose: it fails deterministically on every attempt, so what is
   *  being measured is the schedule rather than the failure. */
  async function seedFailingMoneyEvent(createdAt?: Date) {
    return prisma.outboxEvent.create({
      data: {
        aggregateType: "JournalEntry",
        aggregateId: randomUUID(),
        eventType: "journal_entry.payment_captured",
        payload: { journalEntryId: "not-a-valid-uuid" },
        ...(createdAt ? { createdAt } : {}),
      },
    });
  }

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
      const event = await seedFailingMoneyEvent();
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
      const old = await seedFailingMoneyEvent(
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
