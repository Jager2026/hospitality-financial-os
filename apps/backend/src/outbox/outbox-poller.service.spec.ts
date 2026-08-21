import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LedgerService } from "../ledger/ledger.service";
import { PrismaService } from "../prisma/prisma.service";
import type { RestaurantService } from "../restaurant/restaurant.service";
import { StripeService } from "../stripe/stripe.service";
import { IndividualTipAllocationStrategy } from "../tip/individual-tip-allocation.strategy";
import { WalletProjectionService } from "../wallet/wallet-projection.service";
import { WebhooksService } from "../webhooks/webhooks.service";
import { OutboxPollerService } from "./outbox-poller.service";

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
  warn: () => undefined,
  error: () => undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

// ADR-031: no ALERT_WEBHOOK_URL configured, matching this file's own tests below — none of them
// drive any single event's attempts up to MAX_ATTEMPTS_BEFORE_ALERT (5), so sendAlert() is never
// actually exercised by this describe block regardless; a real, configured URL is exercised
// separately in the dedicated "OutboxPollerService alerting" describe block below.
const fakeConfigNoAlert = {
  get: () => undefined,
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
    const stripe = new StripeService({
      getOrThrow: (key: string) =>
        key === "STRIPE_WEBHOOK_SECRET" ? WEBHOOK_SECRET : "sk_test_fake_never_called",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const ledger = new LedgerService(prisma);
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
    poller = new OutboxPollerService(prisma, walletProjection, fakeLogger, fakeConfigNoAlert);

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
  async function pollUntilSettled(ids: string[], maxIterations = 20): Promise<void> {
    for (let i = 0; i < maxIterations; i++) {
      const remaining = await prisma.outboxEvent.count({
        where: { id: { in: ids }, publishedAt: null },
      });
      if (remaining === 0) return;
      await poller.poll();
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

// ADR-031: Outbox Lag alerting. A separate describe block (own PrismaService, own
// WalletProjectionService, own OutboxPollerService instances per test) rather than reusing the
// shared `poller` above — each test here needs its own ALERT_WEBHOOK_URL/fetch mock, and the
// shared poller above is deliberately built with alerting off (fakeConfigNoAlert) so the tests in
// the first describe block stay unaffected by this one.
describe("OutboxPollerService alerting (ADR-031)", () => {
  const prisma = new PrismaService();
  let walletProjection: WalletProjectionService;

  beforeAll(async () => {
    await prisma.$connect();
    walletProjection = new WalletProjectionService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function buildConfig(url: string | undefined) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { get: () => url } as any;
  }

  // The real dev database is shared with every other concurrently-running test file/worker in a
  // full suite run (this file's own pollUntilSettled/pollUntilAttempts comments already document
  // this) — poll() always dispatches EVERY unpublished row, not just the one this test seeded, so
  // some unrelated stray row from elsewhere can coincidentally cross the exact attempts===5
  // boundary while THIS test's poller (with its own mocked fetch) happens to be polling. Counting
  // raw fetchSpy calls would be flaky by construction; scoping to calls whose body actually
  // references this test's own event id is immune to that noise, the same "scope to this test's
  // own ids" discipline this file already applies everywhere else.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function callsForEvent(fetchSpy: any, eventId: string): unknown[] {
    return fetchSpy.mock.calls.filter(([, init]: [string, RequestInit]) => {
      const body = JSON.parse(init.body as string) as { text: string };
      return body.text.includes(eventId);
    });
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
    }
  }

  it(
    "does not call fetch when ALERT_WEBHOOK_URL is unset, even once the failure threshold is crossed — discriminating: a naive implementation that alerts unconditionally would call fetch here too",
    async () => {
      const poller = new OutboxPollerService(
        prisma,
        walletProjection,
        fakeLogger,
        buildConfig(undefined),
      );
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const event = await seedFailingEvent();

      await pollUntilAttempts(poller, event.id, 5);

      const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(after.attempts).toBeGreaterThanOrEqual(5);
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    },
    BACKLOG_SAFE_TIMEOUT_MS,
  );

  it(
    "calls the alert webhook exactly once, on the poll that crosses the threshold, with the event id and attempt count in the body — and does NOT call it again on later retries of the same still-stuck event",
    async () => {
      const poller = new OutboxPollerService(
        prisma,
        walletProjection,
        fakeLogger,
        buildConfig("https://hooks.example.test/incoming"),
      );
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status: 200 }));
      const event = await seedFailingEvent();

      await pollUntilAttempts(poller, event.id, 5);
      // Keep polling well past the threshold — discriminating: a naive implementation that fires
      // on every attempt >= threshold (instead of exactly attempts === threshold) would call fetch
      // again here too, re-alerting the same stuck event every poll.
      await pollUntilAttempts(poller, event.id, 8);

      const calls = callsForEvent(fetchSpy, event.id);
      expect(calls).toHaveLength(1);
      const [url, init] = calls[0] as [string, RequestInit];
      expect(url).toBe("https://hooks.example.test/incoming");
      const body = JSON.parse(init.body as string) as { text: string };
      expect(body.text).toContain(event.id);
      expect(body.text).toContain("5 times");

      fetchSpy.mockRestore();
    },
    BACKLOG_SAFE_TIMEOUT_MS,
  );

  it(
    "a failing alert webhook (rejected fetch) does not crash poll() and does not stop the underlying event's own retry accounting",
    async () => {
      const poller = new OutboxPollerService(
        prisma,
        walletProjection,
        fakeLogger,
        buildConfig("https://hooks.example.test/incoming"),
      );
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("simulated network failure"));
      const event = await seedFailingEvent();

      for (let i = 0; i < 8; i++) {
        await expect(poller.poll()).resolves.toBeUndefined(); // never throws, even while the alert itself is failing
      }

      const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(after.attempts).toBeGreaterThanOrEqual(5); // dispatch's own retry accounting is unaffected by the alert failing
      expect(callsForEvent(fetchSpy, event.id)).toHaveLength(1); // still only attempted once for THIS event, even though it failed

      fetchSpy.mockRestore();
    },
    BACKLOG_SAFE_TIMEOUT_MS,
  );
});
