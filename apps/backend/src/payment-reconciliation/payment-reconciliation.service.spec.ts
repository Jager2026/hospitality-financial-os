import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PermanentRejection } from "../common/errors/permanent-rejection";
import { PrismaService } from "../prisma/prisma.service";
import type { RetrievedPaymentIntent } from "../stripe/stripe.service";
import type { StripeService } from "../stripe/stripe.service";
import type { WebhooksService } from "../webhooks/webhooks.service";
import { PaymentReconciliationService } from "./payment-reconciliation.service";

const fakeLogger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const PENDING_THRESHOLD_MS = 15 * 60 * 1000;
// Same "bounded catch-up" reasoning as outbox-poller.service.spec.ts's own pollUntilSettled: the
// real dev database accumulates stuck PENDING Payment rows across every session that has ever run
// this suite (131 of them, dating back over a week, confirmed directly against the database, not
// assumed) — reconcile()'s own BATCH_SIZE cap (oldest-first) means a single call can genuinely
// miss a freshly-seeded test payment that sorts newer than 100 older stragglers. A bounded retry
// reaches it regardless, the same way the real 5-minute @Interval eventually would in production.
const RECONCILIATION_SAFE_TIMEOUT_MS = 30_000;

describe("PaymentReconciliationService (real database)", () => {
  const prisma = new PrismaService();

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedRestaurant(withStripeAccount = true) {
    const org = await prisma.organization.create({ data: { name: "Reconciliation Test Org" } });
    return prisma.restaurant.create({
      data: {
        organizationId: org.id,
        name: "Reconciliation Test Restaurant",
        legalName: "Reconciliation Test Restaurant UAB",
        companyNumber: `RC-${randomUUID()}`,
        vatNumber: `LT${randomUUID()}`,
        email: `restaurant-${randomUUID()}@example.com`,
        phone: "+37060000008",
        country: "LT",
        currency: "EUR",
        defaultCustomerLocale: "en",
        timezone: "Europe/Vilnius",
        address: "Test address",
        stripeAccountId: withStripeAccount ? `acct_fake_${randomUUID()}` : null,
      },
    });
  }

  async function seedPendingPayment(restaurantId: string, ageMs: number) {
    const key = `reconciliation-test-key-${randomUUID()}`;
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
        processorPaymentId: `pi_${randomUUID()}`,
        amount: 1000n,
        tipAmount: 0n,
        currency: "EUR",
        status: "PENDING",
        paymentMethod: "card",
        idempotencyKey: key,
        createdAt: new Date(Date.now() - ageMs),
      },
    });
  }

  function fakeStripe(
    retrievePaymentIntent: (...args: unknown[]) => Promise<RetrievedPaymentIntent>,
  ) {
    return { retrievePaymentIntent } as unknown as StripeService;
  }

  function fakeWebhooks(captureFromPaymentIntentId: (...args: unknown[]) => Promise<void>) {
    return { captureFromPaymentIntentId } as unknown as WebhooksService;
  }

  async function reconcileUntil(
    service: PaymentReconciliationService,
    predicate: () => boolean,
    maxIterations = 5,
  ): Promise<void> {
    for (let i = 0; i < maxIterations; i++) {
      if (predicate()) return;
      await service.reconcile();
    }
  }

  it("does not touch a PENDING payment younger than the threshold — no batching concern, it never matches the query's own createdAt filter regardless of how many older stragglers exist", async () => {
    const restaurant = await seedRestaurant();
    const payment = await seedPendingPayment(restaurant.id, 5 * 60 * 1000); // 5 min old
    const retrievePaymentIntent = vi
      .fn()
      .mockResolvedValue({ id: "irrelevant", status: "succeeded" });
    const service = new PaymentReconciliationService(
      prisma,
      fakeStripe(retrievePaymentIntent),
      fakeWebhooks(vi.fn()),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { sendAlert: vi.fn() } as any,
      fakeLogger,
    );

    await service.reconcile();

    const touchedThisPayment = retrievePaymentIntent.mock.calls.some(
      (c) => c[1] === payment.processorPaymentId,
    );
    expect(touchedThisPayment).toBe(false);
  });

  it(
    "self-heals a stuck PENDING payment that Stripe already confirmed succeeded — discriminating: a naive implementation that only alerts (never re-checks Stripe) would never call captureFromPaymentIntentId at all",
    async () => {
      const restaurant = await seedRestaurant();
      const payment = await seedPendingPayment(restaurant.id, PENDING_THRESHOLD_MS + 60_000);
      const retrievePaymentIntent = vi
        .fn()
        .mockResolvedValue({ id: "doesnt-matter", status: "succeeded" });
      const captureFromPaymentIntentId = vi.fn().mockResolvedValue(undefined);
      const service = new PaymentReconciliationService(
        prisma,
        fakeStripe(retrievePaymentIntent),
        fakeWebhooks(captureFromPaymentIntentId),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { sendAlert: vi.fn() } as any,
        fakeLogger,
      );

      await reconcileUntil(service, () =>
        captureFromPaymentIntentId.mock.calls.some((c) => c[0] === payment.processorPaymentId),
      );

      expect(captureFromPaymentIntentId).toHaveBeenCalledWith(payment.processorPaymentId);
    },
    RECONCILIATION_SAFE_TIMEOUT_MS,
  );

  it(
    "alerts (does not self-heal) when Stripe reports the payment is still not succeeded, and marks reconciliationAlertSentAt",
    async () => {
      const restaurant = await seedRestaurant();
      const payment = await seedPendingPayment(restaurant.id, PENDING_THRESHOLD_MS + 60_000);
      const retrievePaymentIntent = vi
        .fn()
        .mockResolvedValue({ id: "doesnt-matter", status: "requires_payment_method" });
      const captureFromPaymentIntentId = vi.fn();
      const sendAlert = vi.fn().mockResolvedValue(undefined);
      const service = new PaymentReconciliationService(
        prisma,
        fakeStripe(retrievePaymentIntent),
        fakeWebhooks(captureFromPaymentIntentId),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { sendAlert } as any,
        fakeLogger,
      );

      await reconcileUntil(service, () =>
        sendAlert.mock.calls.some((c) => (c[0] as string).includes(payment.id)),
      );

      const alertsForThisPayment = sendAlert.mock.calls.filter((c) =>
        (c[0] as string).includes(payment.id),
      );
      expect(alertsForThisPayment).toHaveLength(1);
      expect(alertsForThisPayment[0][0]).toContain("requires_payment_method");
      expect(
        captureFromPaymentIntentId.mock.calls.some((c) => c[0] === payment.processorPaymentId),
      ).toBe(false);

      const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(after.reconciliationAlertSentAt).not.toBeNull();
    },
    RECONCILIATION_SAFE_TIMEOUT_MS,
  );

  it(
    "does not re-alert an already-alerted payment on a later cycle, but keeps checking it against Stripe for self-healing — discriminating: filtering the reconcile query by reconciliationAlertSentAt (an earlier draft's own bug) would stop self-healing forever, not just stop re-alerting",
    async () => {
      const restaurant = await seedRestaurant();
      const payment = await seedPendingPayment(restaurant.id, PENDING_THRESHOLD_MS + 60_000);
      const captureFromPaymentIntentId = vi.fn().mockResolvedValue(undefined);
      const sendAlert = vi.fn().mockResolvedValue(undefined);

      // Cycle(s): still stuck — alerts once, however many reconcile() calls it takes to reach it.
      const stillStuck = vi.fn().mockResolvedValue({ id: "doesnt-matter", status: "processing" });
      const service1 = new PaymentReconciliationService(
        prisma,
        fakeStripe(stillStuck),
        fakeWebhooks(captureFromPaymentIntentId),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { sendAlert } as any,
        fakeLogger,
      );
      await reconcileUntil(service1, () =>
        sendAlert.mock.calls.some((c) => (c[0] as string).includes(payment.id)),
      );
      const alertsAfterCycle1 = sendAlert.mock.calls.filter((c) =>
        (c[0] as string).includes(payment.id),
      );
      expect(alertsAfterCycle1).toHaveLength(1);

      // Now Stripe reports success — must still self-heal despite already being alerted, and must
      // not add a second alert call for this same payment.
      const nowSucceeded = vi.fn().mockResolvedValue({ id: "doesnt-matter", status: "succeeded" });
      const service2 = new PaymentReconciliationService(
        prisma,
        fakeStripe(nowSucceeded),
        fakeWebhooks(captureFromPaymentIntentId),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { sendAlert } as any,
        fakeLogger,
      );
      await reconcileUntil(service2, () =>
        captureFromPaymentIntentId.mock.calls.some((c) => c[0] === payment.processorPaymentId),
      );

      expect(captureFromPaymentIntentId).toHaveBeenCalledWith(payment.processorPaymentId);
      const alertsAfterCycle2 = sendAlert.mock.calls.filter((c) =>
        (c[0] as string).includes(payment.id),
      );
      expect(alertsAfterCycle2).toHaveLength(1); // still just the one — not re-alerted
    },
    RECONCILIATION_SAFE_TIMEOUT_MS,
  );

  it(
    "alerts with a distinct message when Stripe itself cannot be reached, and does not misreport a self-healing (capture) failure as a Stripe-connectivity failure",
    async () => {
      const restaurant = await seedRestaurant();
      const payment = await seedPendingPayment(restaurant.id, PENDING_THRESHOLD_MS + 60_000);
      const retrievePaymentIntent = vi.fn().mockRejectedValue(new Error("simulated Stripe outage"));
      const captureFromPaymentIntentId = vi.fn();
      const sendAlert = vi.fn().mockResolvedValue(undefined);
      const service = new PaymentReconciliationService(
        prisma,
        fakeStripe(retrievePaymentIntent),
        fakeWebhooks(captureFromPaymentIntentId),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { sendAlert } as any,
        fakeLogger,
      );

      await reconcileUntil(service, () =>
        sendAlert.mock.calls.some((c) => (c[0] as string).includes(payment.id)),
      );

      expect(
        captureFromPaymentIntentId.mock.calls.some((c) => c[0] === payment.processorPaymentId),
      ).toBe(false);
      const [message] = sendAlert.mock.calls.find((c) => (c[0] as string).includes(payment.id)) as [
        string,
      ];
      expect(message).toContain("could not be reached");
      expect(message).toContain("simulated Stripe outage");
    },
    RECONCILIATION_SAFE_TIMEOUT_MS,
  );

  it(
    "a capture (self-healing) failure for one payment does not stop reconciliation of the rest of the batch, and the whole cycle itself never throws — discriminating: an unguarded per-payment call (this class's own earlier bug) would abort the cycle on the first failure",
    async () => {
      const restaurant = await seedRestaurant();
      const payment = await seedPendingPayment(restaurant.id, PENDING_THRESHOLD_MS + 60_000);
      const retrievePaymentIntent = vi
        .fn()
        .mockResolvedValue({ id: "doesnt-matter", status: "succeeded" });
      const captureFromPaymentIntentId = vi.fn().mockImplementation((piId: string) => {
        if (piId === payment.processorPaymentId) {
          return Promise.reject(new Error("simulated Ledger write failure"));
        }
        return Promise.resolve(undefined);
      });
      const service = new PaymentReconciliationService(
        prisma,
        fakeStripe(retrievePaymentIntent),
        fakeWebhooks(captureFromPaymentIntentId),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { sendAlert: vi.fn() } as any,
        fakeLogger,
      );

      await reconcileUntil(service, () =>
        captureFromPaymentIntentId.mock.calls.some((c) => c[0] === payment.processorPaymentId),
      );

      // The call that failed is still visible — proves it was attempted, not silently skipped —
      // and every reconcile() call it took to reach it resolved cleanly (reconcileUntil's own
      // await would have thrown otherwise).
      expect(captureFromPaymentIntentId).toHaveBeenCalledWith(payment.processorPaymentId);
    },
    RECONCILIATION_SAFE_TIMEOUT_MS,
  );

  it(
    "does not alert when the Restaurant has no Stripe account, without ever calling Stripe for this payment",
    async () => {
      const restaurant = await seedRestaurant(false);
      const payment = await seedPendingPayment(restaurant.id, PENDING_THRESHOLD_MS + 60_000);
      const retrievePaymentIntent = vi.fn().mockResolvedValue({ id: "x", status: "succeeded" });
      const sendAlert = vi.fn().mockResolvedValue(undefined);
      const service = new PaymentReconciliationService(
        prisma,
        fakeStripe(retrievePaymentIntent),
        fakeWebhooks(vi.fn()),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { sendAlert } as any,
        fakeLogger,
      );

      await reconcileUntil(service, () =>
        sendAlert.mock.calls.some((c) => (c[0] as string).includes(payment.id)),
      );

      expect(
        retrievePaymentIntent.mock.calls.some((c) => c[1] === payment.processorPaymentId),
      ).toBe(false);
      const [message] = sendAlert.mock.calls.find((c) => (c[0] as string).includes(payment.id)) as [
        string,
      ];
      expect(message).toContain("no Stripe account");
    },
    RECONCILIATION_SAFE_TIMEOUT_MS,
  );
});

// ADR-085 — the queue's second exit. `Payment.status` has had CANCELED, FAILED and DECLINED in
// its enum since the schema was written and nothing had ever written one; a Payment could leave
// PENDING only by succeeding, so everything that did not succeed stayed in the oldest-first batch
// of 100 forever.
describe("PaymentReconciliationService concluding a stuck payment (ADR-085)", () => {
  const prisma = new PrismaService();

  const BATCH_SIZE = 100; // mirrors the constant in the service; the ballast below must exceed it

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedRestaurant85() {
    const org = await prisma.organization.create({ data: { name: "ADR-085 Test Org" } });
    return prisma.restaurant.create({
      data: {
        organizationId: org.id,
        name: "ADR-085 Test Restaurant",
        legalName: "ADR-085 Test Restaurant UAB",
        companyNumber: `RC85-${randomUUID()}`,
        vatNumber: `LT85${randomUUID()}`,
        email: `restaurant-${randomUUID()}@example.com`,
        phone: "+37060000009",
        country: "LT",
        currency: "EUR",
        defaultCustomerLocale: "en",
        timezone: "Europe/Vilnius",
        address: "Test address",
        stripeAccountId: `acct_fake_${randomUUID()}`,
      },
    });
  }

  // Payment.idempotency_key is a real foreign key, so the key row has to exist first — the same
  // two-step this file has always done, kept here rather than reusing the other block private
  // helper so each describe stays readable on its own.
  async function seedStuck(restaurantId: string, processorPaymentId: string, createdAt: Date) {
    const key = `adr085-${randomUUID()}`;
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
        amount: 1000n,
        tipAmount: 0n,
        currency: "EUR",
        status: "PENDING",
        paymentMethod: "card",
        idempotencyKey: key,
        createdAt,
      },
    });
  }

  function buildService(
    retrievePaymentIntent: ReturnType<typeof vi.fn>,
    sendAlert: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined),
  ) {
    return new PaymentReconciliationService(
      prisma,
      { retrievePaymentIntent } as unknown as StripeService,
      { captureFromPaymentIntentId: vi.fn() } as unknown as WebhooksService,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { sendAlert } as any,
      fakeLogger,
    );
  }

  /** Cycles until Stripe has actually been asked about this payment id — the shared dev database
   *  can hold older stuck rows that fill part of the batch (the same bounded-catch-up reasoning
   *  this file already uses), and this reaches THIS test's own row regardless. */
  async function reconcileUntilTouched(
    service: PaymentReconciliationService,
    retrievePaymentIntent: ReturnType<typeof vi.fn>,
    processorPaymentId: string,
    maxCycles = 5,
  ): Promise<void> {
    for (let i = 0; i < maxCycles; i++) {
      if (retrievePaymentIntent.mock.calls.some((c) => c[1] === processorPaymentId)) return;
      await service.reconcile();
    }
  }

  it(
    "a PaymentIntent Stripe reports as canceled concludes the Payment as CANCELED, and a later " +
      "cycle does not ask about it again — discriminating: an implementation that only alerts " +
      "leaves the row PENDING, so it is re-retrieved from Stripe every five minutes forever",
    async () => {
      const restaurant = await seedRestaurant85();
      const piId = `pi_adr085_cancelled_${randomUUID()}`;
      const payment = await seedStuck(
        restaurant.id,
        piId,
        new Date(Date.now() - PENDING_THRESHOLD_MS - 60_000),
      );
      const retrievePaymentIntent = vi.fn(async (_acct: unknown, id: unknown) => ({
        id: String(id),
        status: id === piId ? "canceled" : "requires_payment_method",
      })) as unknown as ReturnType<typeof vi.fn>;
      const service = buildService(retrievePaymentIntent);

      await reconcileUntilTouched(service, retrievePaymentIntent, piId);

      const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(after.status, "a canceled PaymentIntent left its Payment in PENDING").toBe("CANCELED");

      // THE HALF THAT REJECTS THE OLD IMPLEMENTATION: it has left the queue, so the next cycle
      // does not touch it at all.
      const callsBefore = retrievePaymentIntent.mock.calls.filter((c) => c[1] === piId).length;
      await service.reconcile();
      const callsAfter = retrievePaymentIntent.mock.calls.filter((c) => c[1] === piId).length;
      expect(callsAfter, "a concluded Payment was asked about again").toBe(callsBefore);
    },
    RECONCILIATION_SAFE_TIMEOUT_MS,
  );

  it(
    "a PaymentIntent Stripe has never heard of concludes the Payment as FAILED, and the alert says " +
      "so rather than blaming the connection — discriminating: before ADR-085 every error from " +
      "retrievePaymentIntent produced the same unreachable-Stripe message, which points whoever " +
      "reads it at the wrong system",
    async () => {
      const restaurant = await seedRestaurant85();
      const piId = `pi_adr085_missing_${randomUUID()}`;
      const payment = await seedStuck(
        restaurant.id,
        piId,
        new Date(Date.now() - PENDING_THRESHOLD_MS - 60_000),
      );
      const sendAlert = vi.fn().mockResolvedValue(undefined);
      const retrievePaymentIntent = vi.fn(async (_acct: unknown, id: unknown) => {
        if (id === piId) {
          throw new PermanentRejection(`Stripe PaymentIntent ${piId} does not exist`);
        }
        return { id: String(id), status: "requires_payment_method" };
      }) as unknown as ReturnType<typeof vi.fn>;
      const service = buildService(retrievePaymentIntent, sendAlert);

      await reconcileUntilTouched(service, retrievePaymentIntent, piId);

      const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(after.status).toBe("FAILED");
      const alerts = sendAlert.mock.calls.filter((c) => (c[0] as string).includes(payment.id));
      expect(alerts, "concluding a Payment happened silently").toHaveLength(1);
      expect(alerts[0][0]).toContain("does not exist");
    },
    RECONCILIATION_SAFE_TIMEOUT_MS,
  );

  it(
    "a TRANSIENT Stripe error keeps exactly today's behaviour — the Payment stays PENDING, is " +
      "alerted once, and is still asked about on the next cycle. The discriminating pair for the " +
      "test above: same call, same throw site, opposite answer, because a connection problem is " +
      "not an answer about the payment",
    async () => {
      const restaurant = await seedRestaurant85();
      const piId = `pi_adr085_transient_${randomUUID()}`;
      const payment = await seedStuck(
        restaurant.id,
        piId,
        new Date(Date.now() - PENDING_THRESHOLD_MS - 60_000),
      );
      const sendAlert = vi.fn().mockResolvedValue(undefined);
      const retrievePaymentIntent = vi.fn(async (_acct: unknown, id: unknown) => {
        if (id === piId) throw new Error("connection error to Stripe");
        return { id: String(id), status: "requires_payment_method" };
      }) as unknown as ReturnType<typeof vi.fn>;
      const service = buildService(retrievePaymentIntent, sendAlert);

      await reconcileUntilTouched(service, retrievePaymentIntent, piId);
      const callsBefore = retrievePaymentIntent.mock.calls.filter((c) => c[1] === piId).length;
      await service.reconcile();
      const callsAfter = retrievePaymentIntent.mock.calls.filter((c) => c[1] === piId).length;

      const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(
        after.status,
        "a transient failure concluded a Payment — the row would be written off while the money may still be in flight",
      ).toBe("PENDING");
      expect(callsAfter, "a still-open Payment stopped being checked").toBeGreaterThan(callsBefore);
      expect(
        sendAlert.mock.calls.filter((c) => (c[0] as string).includes(payment.id)),
      ).toHaveLength(1);
    },
    RECONCILIATION_SAFE_TIMEOUT_MS,
  );

  it(
    "a head of payments that can never resolve does not starve a newer one — the falsification: " +
      "with no terminal state the oldest 100 are the same 100 on every cycle, and the 111th is " +
      "never reached however long the worker runs",
    async () => {
      const restaurant = await seedRestaurant85();
      // Backdated far enough that nothing else in this shared database sorts ahead of them, so the
      // batch really is made of this test's own rows.
      const base = Date.now() - 60 * 24 * 60 * 60 * 1000;
      const ballast: string[] = [];
      for (let i = 0; i < BATCH_SIZE + 10; i++) {
        const piId = `pi_adr085_ballast_${randomUUID()}`;
        await seedStuck(restaurant.id, piId, new Date(base + i * 1000));
        ballast.push(piId);
      }
      const behind = `pi_adr085_behind_${randomUUID()}`;
      await seedStuck(restaurant.id, behind, new Date(base + (BATCH_SIZE + 10) * 1000));

      const retrievePaymentIntent = vi.fn(async (_acct: unknown, id: unknown) => {
        if (ballast.includes(String(id))) {
          throw new PermanentRejection(`Stripe PaymentIntent ${String(id)} does not exist`);
        }
        // Everything else in the database — including whatever other specs have left behind —
        // answers with a NON-terminal status, so nothing but the ballast is concluded here and the
        // assertion is about the ballast alone.
        return { id: String(id), status: "requires_payment_method" };
      }) as unknown as ReturnType<typeof vi.fn>;
      const service = buildService(retrievePaymentIntent);

      // Two cycles clear the ballast (one full batch, then the remaining ten) and reach past it; a
      // third is allowed for the shared database's own older stragglers.
      await service.reconcile();
      await service.reconcile();
      await service.reconcile();

      expect(
        retrievePaymentIntent.mock.calls.some((c) => c[1] === behind),
        "a payment behind a head of unresolvable rows was never reached",
      ).toBe(true);
    },
    120_000,
  );
});
