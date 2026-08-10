import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    poller = new OutboxPollerService(prisma, walletProjection, fakeLogger);

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

  it("poll() dispatches a real payment_captured/tip_allocated event pair to WalletProjectionService, marks published_at, and does NOT increment attempts on success — discriminating: the pre-Sprint-7 skeleton incremented attempts unconditionally, even on a successful dispatch", async () => {
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

    const wallet = await prisma.wallet.findUnique({ where: { membershipId: waiterMembership.id } });
    expect(wallet?.availableBalance).toBe(500n); // the real effect: Wallet actually updated
  });

  it("poll() does not re-process an already-published event on a second call", async () => {
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
  });

  it("a malformed event fails, increments attempts, and leaves published_at null — proves the retry path is real, not just the success path", async () => {
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
  });
});
