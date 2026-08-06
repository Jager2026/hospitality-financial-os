import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LedgerService } from "../ledger/ledger.service";
import { PrismaService } from "../prisma/prisma.service";
import type { RestaurantService } from "../restaurant/restaurant.service";
import { StripeService } from "../stripe/stripe.service";
import { WebhooksService } from "./webhooks.service";

// Real database, real LedgerService, and a REAL StripeService (genuine HMAC signature
// verification via stripe.webhooks.constructEvent — no network call, so no real Stripe
// credentials needed) — only RestaurantService is faked, since account.updated's own logic is
// covered on its own terms in restaurant.service.spec.ts (refreshStripeStatusByAccountId).
const WEBHOOK_SECRET = "whsec_test_fake_secret_for_signing_only";

function signEvent(payload: object): { rawBody: Buffer; signature: string; event: { id: string } } {
  const raw = JSON.stringify(payload);
  const header = Stripe.webhooks.generateTestHeaderString({ payload: raw, secret: WEBHOOK_SECRET });
  return { rawBody: Buffer.from(raw), signature: header, event: payload as { id: string } };
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

describe("WebhooksService (real database, real signature verification)", () => {
  const prisma = new PrismaService();
  let service: WebhooksService;
  let ledger: LedgerService;
  const fakeRestaurantService = {
    refreshStripeStatusByAccountId: vi.fn().mockResolvedValue(null),
  } as unknown as RestaurantService;

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.currency.upsert({
      where: { code: "EUR" },
      update: {},
      create: { code: "EUR", exponent: 2, name: "Euro" },
    });

    const stripe = new StripeService({
      getOrThrow: (key: string) =>
        key === "STRIPE_WEBHOOK_SECRET" ? WEBHOOK_SECRET : "sk_test_fake_never_called",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    ledger = new LedgerService(prisma);
    service = new WebhooksService(prisma, stripe, ledger, fakeRestaurantService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedOrgRestaurant() {
    const org = await prisma.organization.create({ data: { name: "Webhook Test Org" } });
    const restaurant = await prisma.restaurant.create({
      data: {
        organizationId: org.id,
        name: "Webhook Test Restaurant",
        legalName: "Webhook Test Restaurant UAB",
        companyNumber: `WH-${randomUUID()}`,
        vatNumber: `LT${randomUUID()}`,
        email: `restaurant-${randomUUID()}@example.com`,
        phone: "+37060000004",
        country: "LT",
        currency: "EUR",
        defaultCustomerLocale: "en",
        timezone: "Europe/Vilnius",
        address: "Test address",
        stripeAccountId: `acct_fake_${randomUUID()}`,
      },
    });
    return restaurant;
  }

  async function seedPayment(restaurantId: string, amount: bigint, processorPaymentId: string) {
    const key = `wh-test-key-${randomUUID()}`;
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
        currency: "EUR",
        status: "PENDING",
        paymentMethod: "card",
        idempotencyKey: key,
      },
    });
  }

  it("rejects a tampered/invalid signature", async () => {
    const payload = buildEvent("payment_intent.succeeded", { id: "pi_whatever" });
    const raw = Buffer.from(JSON.stringify(payload));

    await expect(service.handleEvent(raw, "t=1,v1=not-a-real-signature")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("rejects a request with no signature header at all", async () => {
    const payload = buildEvent("payment_intent.succeeded", { id: "pi_whatever" });
    const raw = Buffer.from(JSON.stringify(payload));

    await expect(service.handleEvent(raw, undefined)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("payment_intent.succeeded: marks Payment SUCCEEDED, creates a Transaction, posts a balanced JournalEntry", async () => {
    const restaurant = await seedOrgRestaurant();
    const piId = `pi_${randomUUID()}`;
    const payment = await seedPayment(restaurant.id, 1550n, piId);

    const { rawBody, signature } = signEvent(
      buildEvent("payment_intent.succeeded", { id: piId, amount: 1550, currency: "eur" }),
    );

    await service.handleEvent(rawBody, signature);

    const updatedPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(updatedPayment?.status).toBe("SUCCEEDED");

    const transaction = await prisma.transaction.findUnique({ where: { paymentId: payment.id } });
    expect(transaction?.grossAmount).toBe(1550n);
    expect(transaction?.status).toBe("COMPLETED");

    const lines = await prisma.ledgerLine.findMany({
      where: { journalEntry: { transactionId: transaction?.id } },
    });
    expect(lines).toHaveLength(2);
    const debit = lines.find((l) => l.direction === "DEBIT");
    const credit = lines.find((l) => l.direction === "CREDIT");
    expect(debit?.account).toBe("PROCESSOR_CLEARING");
    expect(debit?.amount).toBe(1550n);
    expect(credit?.account).toBe("RESTAURANT_REVENUE_PAYABLE");
    expect(credit?.amount).toBe(1550n); // no fee split yet — full amount to Restaurant Revenue
  });

  it("deduplicates by Stripe event id: replaying the exact same event does not create a second Transaction", async () => {
    const restaurant = await seedOrgRestaurant();
    const piId = `pi_${randomUUID()}`;
    const payment = await seedPayment(restaurant.id, 1000n, piId);

    const eventPayload = buildEvent("payment_intent.succeeded", {
      id: piId,
      amount: 1000,
      currency: "eur",
    });
    const { rawBody, signature } = signEvent(eventPayload);

    await service.handleEvent(rawBody, signature);
    await service.handleEvent(rawBody, signature); // exact same event.id, replayed

    const transactions = await prisma.transaction.findMany({ where: { paymentId: payment.id } });
    expect(transactions).toHaveLength(1);
  });

  it("charge.refunded: two sequential partial refunds each record their own correct DELTA amount, not the cumulative total twice", async () => {
    const restaurant = await seedOrgRestaurant();
    const piId = `pi_${randomUUID()}`;
    const payment = await seedPayment(restaurant.id, 2000n, piId);

    const { rawBody: succeededRaw, signature: succeededSig } = signEvent(
      buildEvent("payment_intent.succeeded", { id: piId, amount: 2000, currency: "eur" }),
    );
    await service.handleEvent(succeededRaw, succeededSig);
    const transaction = await prisma.transaction.findUnique({ where: { paymentId: payment.id } });

    // First partial refund: 500 of 2000.
    const chargeId = `ch_${randomUUID()}`;
    const { rawBody: firstRaw, signature: firstSig } = signEvent(
      buildEvent("charge.refunded", {
        id: chargeId,
        payment_intent: piId,
        amount_refunded: 500,
        refunds: { data: [{ id: `re_${randomUUID()}`, reason: "requested_by_customer" }] },
      }),
    );
    await service.handleEvent(firstRaw, firstSig);

    // Second partial refund: cumulative amount_refunded is now 800 (a further 300).
    const { rawBody: secondRaw, signature: secondSig } = signEvent(
      buildEvent("charge.refunded", {
        id: chargeId,
        payment_intent: piId,
        amount_refunded: 800,
        refunds: { data: [{ id: `re_${randomUUID()}`, reason: "requested_by_customer" }] },
      }),
    );
    await service.handleEvent(secondRaw, secondSig);

    const refunds = await prisma.refund.findMany({
      where: { transactionId: transaction?.id },
      orderBy: { createdAt: "asc" },
    });
    expect(refunds).toHaveLength(2);
    expect(refunds[0].amount).toBe(500n); // NOT 500 then another 800 (which would double-count)
    expect(refunds[1].amount).toBe(300n);

    const updatedTransaction = await prisma.transaction.findUnique({
      where: { id: transaction?.id },
    });
    expect(updatedTransaction?.status).toBe("PARTIALLY_REFUNDED"); // 800 < 2000 gross

    const refundLines = await prisma.ledgerLine.findMany({
      where: { journalEntry: { transactionId: transaction?.id, entryType: "REFUND_ISSUED" } },
    });
    expect(refundLines).toHaveLength(4); // 2 lines per compensating entry x 2 refunds
    const totalDebited = refundLines
      .filter((l) => l.direction === "DEBIT")
      .reduce((sum, l) => sum + l.amount, 0n);
    expect(totalDebited).toBe(800n); // matches the cumulative amount actually refunded
  });

  it("charge.dispute.created then charge.dispute.closed (won): provisional loss is fully reversed", async () => {
    const restaurant = await seedOrgRestaurant();
    const piId = `pi_${randomUUID()}`;
    const payment = await seedPayment(restaurant.id, 3000n, piId);

    const { rawBody: succeededRaw, signature: succeededSig } = signEvent(
      buildEvent("payment_intent.succeeded", { id: piId, amount: 3000, currency: "eur" }),
    );
    await service.handleEvent(succeededRaw, succeededSig);
    const transaction = await prisma.transaction.findUnique({ where: { paymentId: payment.id } });

    const disputeId = `dp_${randomUUID()}`;
    const { rawBody: createdRaw, signature: createdSig } = signEvent(
      buildEvent("charge.dispute.created", {
        id: disputeId,
        payment_intent: piId,
        amount: 3000,
        reason: "fraudulent",
        status: "warning_needs_response",
        evidence_details: { due_by: null },
      }),
    );
    await service.handleEvent(createdRaw, createdSig);

    const chargeback = await prisma.chargeback.findFirst({
      where: { processorDisputeId: disputeId },
    });
    expect(chargeback?.status).toBe("UNDER_REVIEW");
    expect(chargeback?.amount).toBe(3000n);

    const afterCreated = await prisma.transaction.findUnique({ where: { id: transaction?.id } });
    expect(afterCreated?.status).toBe("DISPUTED");

    const { rawBody: closedRaw, signature: closedSig } = signEvent(
      buildEvent("charge.dispute.closed", {
        id: disputeId,
        payment_intent: piId,
        amount: 3000,
        reason: "fraudulent",
        status: "won",
        evidence_details: { due_by: null },
      }),
    );
    await service.handleEvent(closedRaw, closedSig);

    const resolvedChargeback = await prisma.chargeback.findFirst({
      where: { processorDisputeId: disputeId },
    });
    expect(resolvedChargeback?.status).toBe("WON");
    expect(resolvedChargeback?.resolvedAt).not.toBeNull();

    const chargebackLines = await prisma.ledgerLine.findMany({
      where: { journalEntry: { transactionId: transaction?.id, entryType: "CHARGEBACK" } },
    });
    // 2 lines for the provisional loss + 2 lines for the reversal = 4, net effect zero.
    expect(chargebackLines).toHaveLength(4);
    const netRestaurantRevenue = chargebackLines
      .filter((l) => l.account === "RESTAURANT_REVENUE_PAYABLE")
      .reduce((sum, l) => sum + (l.direction === "CREDIT" ? l.amount : -l.amount), 0n);
    expect(netRestaurantRevenue).toBe(0n); // debited on open, credited back on WON — net zero
  });

  it("charge.dispute.closed (lost): no reversal entry is posted, provisional loss stands", async () => {
    const restaurant = await seedOrgRestaurant();
    const piId = `pi_${randomUUID()}`;
    const payment = await seedPayment(restaurant.id, 1200n, piId);

    const { rawBody: succeededRaw, signature: succeededSig } = signEvent(
      buildEvent("payment_intent.succeeded", { id: piId, amount: 1200, currency: "eur" }),
    );
    await service.handleEvent(succeededRaw, succeededSig);
    const transaction = await prisma.transaction.findUnique({ where: { paymentId: payment.id } });

    const disputeId = `dp_${randomUUID()}`;
    const { rawBody: createdRaw, signature: createdSig } = signEvent(
      buildEvent("charge.dispute.created", {
        id: disputeId,
        payment_intent: piId,
        amount: 1200,
        reason: "fraudulent",
        status: "warning_needs_response",
        evidence_details: { due_by: null },
      }),
    );
    await service.handleEvent(createdRaw, createdSig);

    const { rawBody: closedRaw, signature: closedSig } = signEvent(
      buildEvent("charge.dispute.closed", {
        id: disputeId,
        payment_intent: piId,
        amount: 1200,
        reason: "fraudulent",
        status: "lost",
        evidence_details: { due_by: null },
      }),
    );
    await service.handleEvent(closedRaw, closedSig);

    const resolvedChargeback = await prisma.chargeback.findFirst({
      where: { processorDisputeId: disputeId },
    });
    expect(resolvedChargeback?.status).toBe("LOST");

    const chargebackLines = await prisma.ledgerLine.findMany({
      where: { journalEntry: { transactionId: transaction?.id, entryType: "CHARGEBACK" } },
    });
    expect(chargebackLines).toHaveLength(2); // only the original provisional loss, no reversal
  });

  it("account.updated: delegates to RestaurantService.refreshStripeStatusByAccountId with the account id from the event", async () => {
    const accountId = `acct_${randomUUID()}`;
    const { rawBody, signature } = signEvent(buildEvent("account.updated", { id: accountId }));

    await service.handleEvent(rawBody, signature);

    expect(fakeRestaurantService.refreshStripeStatusByAccountId).toHaveBeenCalledWith(accountId);
  });
});
