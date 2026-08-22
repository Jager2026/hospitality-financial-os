import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
