import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LedgerService } from "../ledger/ledger.service";
import { PrismaService } from "../prisma/prisma.service";
import type { RestaurantService } from "../restaurant/restaurant.service";
import { StripeService } from "../stripe/stripe.service";
import { IndividualTipAllocationStrategy } from "../tip/individual-tip-allocation.strategy";
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

    const stripe = new StripeService({
      getOrThrow: (key: string) =>
        key === "STRIPE_WEBHOOK_SECRET" ? WEBHOOK_SECRET : "sk_test_fake_never_called",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    ledger = new LedgerService(prisma);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeConfig = { getOrThrow: () => 100 } as any; // 1.00%, Founder decision
    service = new WebhooksService(
      prisma,
      stripe,
      ledger,
      fakeRestaurantService,
      fakeConfig,
      new IndividualTipAllocationStrategy(), // real strategy — MVP's Individual allocation is real code, not a fake, same rigor as everything else money-touching here
    );
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

  async function seedPayment(
    restaurantId: string,
    amount: bigint,
    processorPaymentId: string,
    options?: { tipAmount?: bigint; waiterMembershipId?: string },
  ) {
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
        tipAmount: options?.tipAmount ?? 0n,
        waiterMembershipId: options?.waiterMembershipId,
        currency: "EUR",
        status: "PENDING",
        paymentMethod: "card",
        idempotencyKey: key,
      },
    });
  }

  // ADR-022: a real Membership row for the waiter a tip gets allocated to.
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

  it("payment_intent.succeeded: marks Payment SUCCEEDED, creates a Transaction, posts a balanced 3-line JournalEntry with the platform fee split", async () => {
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
    // 1550 at 100 basis points (1.00%, Founder decision) = 15 fee, 1535 restaurant revenue.
    expect(lines).toHaveLength(3);
    const debit = lines.find((l) => l.direction === "DEBIT");
    const revenue = lines.find((l) => l.account === "RESTAURANT_REVENUE_PAYABLE");
    const fee = lines.find((l) => l.account === "PLATFORM_FEE_REVENUE");
    expect(debit?.account).toBe("PROCESSOR_CLEARING");
    expect(debit?.amount).toBe(1550n);
    expect(revenue?.direction).toBe("CREDIT");
    expect(revenue?.amount).toBe(1535n);
    expect(fee?.direction).toBe("CREDIT");
    expect(fee?.amount).toBe(15n);
    // Balanced: one debit equals the sum of both credits, exactly (no drift — platform-fee.util's
    // own subtraction-derived split guarantees this, verified again here at the Ledger-write level).
    expect((revenue?.amount ?? 0n) + (fee?.amount ?? 0n)).toBe(debit?.amount);
  });

  it("payment_intent.succeeded with a tip (ADR-022): PAYMENT_CAPTURED gains a TIP_PAYABLE line, a separate TIP_ALLOCATED entry credits the waiter's Membership, a Tip row is created ALLOCATED, and the platform fee is computed from billAmount not the full amount — discriminating: a naive amount-based implementation would compute fee=20, not 15", async () => {
    const restaurant = await seedOrgRestaurant();
    const waiterMembership = await seedWaiterMembership(restaurant.organizationId, restaurant.id);
    const piId = `pi_${randomUUID()}`;
    // amount=2000 (bill+tip combined), tipAmount=500 -> billAmount=1500 -> fee = 1% of 1500 = 15,
    // restaurantRevenue = 1485. A naive amount-based fee (1% of 2000 = 20) would fail every
    // assertion below that checks fee/revenue.
    const payment = await seedPayment(restaurant.id, 2000n, piId, {
      tipAmount: 500n,
      waiterMembershipId: waiterMembership.id,
    });

    const { rawBody, signature } = signEvent(
      buildEvent("payment_intent.succeeded", { id: piId, amount: 2000, currency: "eur" }),
    );

    await service.handleEvent(rawBody, signature);

    const transaction = await prisma.transaction.findUnique({ where: { paymentId: payment.id } });
    expect(transaction?.grossAmount).toBe(2000n);

    const journalEntries = await prisma.journalEntry.findMany({
      where: { transactionId: transaction?.id },
      orderBy: { createdAt: "asc" },
    });
    expect(journalEntries.map((e) => e.entryType)).toEqual(["PAYMENT_CAPTURED", "TIP_ALLOCATED"]);

    const capturedLines = await prisma.ledgerLine.findMany({
      where: { journalEntryId: journalEntries[0].id },
    });
    expect(capturedLines).toHaveLength(4);
    const debit = capturedLines.find((l) => l.direction === "DEBIT");
    const revenue = capturedLines.find((l) => l.account === "RESTAURANT_REVENUE_PAYABLE");
    const fee = capturedLines.find((l) => l.account === "PLATFORM_FEE_REVENUE");
    const tipLiability = capturedLines.find((l) => l.account === "TIP_PAYABLE");
    expect(debit?.amount).toBe(2000n); // full charge, bill + tip combined
    expect(revenue?.amount).toBe(1485n); // NOT 1980 (would be if fee were computed on 2000)
    expect(fee?.amount).toBe(15n); // NOT 20
    expect(tipLiability?.direction).toBe("CREDIT");
    expect(tipLiability?.amount).toBe(500n);
    expect(tipLiability?.membershipId).toBeNull(); // general liability, not yet attributed
    expect((revenue?.amount ?? 0n) + (fee?.amount ?? 0n) + (tipLiability?.amount ?? 0n)).toBe(
      debit?.amount,
    ); // still balances exactly with the 4th line included

    const allocatedLines = await prisma.ledgerLine.findMany({
      where: { journalEntryId: journalEntries[1].id },
    });
    expect(allocatedLines).toHaveLength(2);
    const allocDebit = allocatedLines.find((l) => l.direction === "DEBIT");
    const allocCredit = allocatedLines.find((l) => l.direction === "CREDIT");
    expect(allocDebit?.account).toBe("TIP_PAYABLE");
    expect(allocDebit?.amount).toBe(500n);
    expect(allocDebit?.membershipId).toBeNull();
    expect(allocCredit?.account).toBe("TIP_PAYABLE"); // same account both sides — membershipId is the only discriminator (ADR-022)
    expect(allocCredit?.amount).toBe(500n);
    expect(allocCredit?.membershipId).toBe(waiterMembership.id); // exactly one LedgerLine credits the correct Membership's Wallet (Sprint 6 DoD)

    const tip = await prisma.tip.findUnique({ where: { transactionId: transaction?.id } });
    expect(tip?.grossTip).toBe(500n);
    expect(tip?.status).toBe("ALLOCATED");
  });

  it("payment_intent.succeeded with no tip: still exactly one JournalEntry, no TIP_PAYABLE line, no Tip row created", async () => {
    const restaurant = await seedOrgRestaurant();
    const piId = `pi_${randomUUID()}`;
    const payment = await seedPayment(restaurant.id, 1000n, piId, { tipAmount: 0n });

    const { rawBody, signature } = signEvent(
      buildEvent("payment_intent.succeeded", { id: piId, amount: 1000, currency: "eur" }),
    );

    await service.handleEvent(rawBody, signature);

    const transaction = await prisma.transaction.findUnique({ where: { paymentId: payment.id } });
    const journalEntries = await prisma.journalEntry.findMany({
      where: { transactionId: transaction?.id },
    });
    expect(journalEntries).toHaveLength(1);
    expect(journalEntries[0].entryType).toBe("PAYMENT_CAPTURED");

    const lines = await prisma.ledgerLine.findMany({
      where: { journalEntryId: journalEntries[0].id },
    });
    expect(lines.some((l) => l.account === "TIP_PAYABLE")).toBe(false);

    const tip = await prisma.tip.findUnique({ where: { transactionId: transaction?.id } });
    expect(tip).toBeNull(); // Transaction -> zero-or-one Tip (DATABASE.md) — zero here
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
    // 3 lines per compensating entry x 2 refunds (ADR-023: RESTAURANT_REVENUE_PAYABLE +
    // PLATFORM_FEE_REVENUE + REFUND_CONTRA — this Payment has a fee but no tip, so TIP_PAYABLE
    // never appears here; the tip case is covered separately below).
    expect(refundLines).toHaveLength(6);
    const totalDebited = refundLines
      .filter((l) => l.direction === "DEBIT")
      .reduce((sum, l) => sum + l.amount, 0n);
    expect(totalDebited).toBe(800n); // matches the cumulative amount actually refunded
    expect(refundLines.some((l) => l.account === "TIP_PAYABLE")).toBe(false); // no tip on this Payment
  });

  it("charge.refunded with a tip (ADR-023): two sequential partial refunds proportionally claw back RESTAURANT_REVENUE_PAYABLE, PLATFORM_FEE_REVENUE, and the waiter's own TIP_PAYABLE credit — discriminating: an implementation that only reverses RESTAURANT_REVENUE_PAYABLE (Sprint 5/6's original behavior) would leave the fee and the tip both fully standing after a full refund", async () => {
    const restaurant = await seedOrgRestaurant();
    const waiterMembership = await seedWaiterMembership(restaurant.organizationId, restaurant.id);
    const piId = `pi_${randomUUID()}`;
    // amount=2000 (bill+tip), tipAmount=500 -> billAmount=1500 -> fee=15, revenue=1485 (1.00%).
    const payment = await seedPayment(restaurant.id, 2000n, piId, {
      tipAmount: 500n,
      waiterMembershipId: waiterMembership.id,
    });

    const { rawBody: succeededRaw, signature: succeededSig } = signEvent(
      buildEvent("payment_intent.succeeded", { id: piId, amount: 2000, currency: "eur" }),
    );
    await service.handleEvent(succeededRaw, succeededSig);
    const transaction = await prisma.transaction.findUnique({ where: { paymentId: payment.id } });

    // First partial refund: 1000 of 2000 (cumulative fraction = 1/2).
    const chargeId = `ch_${randomUUID()}`;
    const { rawBody: firstRaw, signature: firstSig } = signEvent(
      buildEvent("charge.refunded", {
        id: chargeId,
        payment_intent: piId,
        amount_refunded: 1000,
        refunds: { data: [{ id: `re_${randomUUID()}`, reason: "requested_by_customer" }] },
      }),
    );
    await service.handleEvent(firstRaw, firstSig);

    const firstRefund = await prisma.refund.findFirst({
      where: { transactionId: transaction?.id },
      orderBy: { createdAt: "desc" },
    });
    expect(firstRefund?.tipRefunded).toBe(true); // ADR-023: computed, not hardcoded false

    const firstLines = await prisma.ledgerLine.findMany({
      where: {
        journalEntryId: (
          await prisma.journalEntry.findFirst({
            where: { transactionId: transaction?.id, entryType: "REFUND_ISSUED" },
            orderBy: { createdAt: "asc" },
          })
        )?.id,
      },
    });
    // Half refunded: half of each original share, revenue derived by subtraction.
    // cumulativeTip = floor(500*1000/2000) = 250; cumulativeFee = floor(15*1000/2000) = 7;
    // cumulativeRevenue = 1000 - 250 - 7 = 743.
    expect(firstLines.find((l) => l.account === "RESTAURANT_REVENUE_PAYABLE")?.amount).toBe(743n);
    expect(firstLines.find((l) => l.account === "PLATFORM_FEE_REVENUE")?.amount).toBe(7n);
    const firstTipLine = firstLines.find((l) => l.account === "TIP_PAYABLE");
    expect(firstTipLine?.amount).toBe(250n);
    expect(firstTipLine?.membershipId).toBe(waiterMembership.id); // never the null general line

    // Second partial refund: cumulative amount_refunded is now 2000 (a further 1000) — full refund.
    const { rawBody: secondRaw, signature: secondSig } = signEvent(
      buildEvent("charge.refunded", {
        id: chargeId,
        payment_intent: piId,
        amount_refunded: 2000,
        refunds: { data: [{ id: `re_${randomUUID()}`, reason: "requested_by_customer" }] },
      }),
    );
    await service.handleEvent(secondRaw, secondSig);

    const updatedTransaction = await prisma.transaction.findUnique({
      where: { id: transaction?.id },
    });
    expect(updatedTransaction?.status).toBe("REFUNDED"); // 2000 >= 2000 gross

    // Net across BOTH refunds must equal the full original capture-time credits exactly — this
    // ADR's own worked example (1485/15/500), verified here via two partial deltas, not one
    // single full-refund shot, so a naive per-event (not cumulative-then-delta) implementation
    // that double-counts or under-counts the second event would fail these totals.
    const allRefundLines = await prisma.ledgerLine.findMany({
      where: { journalEntry: { transactionId: transaction?.id, entryType: "REFUND_ISSUED" } },
    });
    const sumByAccount = (account: string) =>
      allRefundLines.filter((l) => l.account === account).reduce((sum, l) => sum + l.amount, 0n);
    expect(sumByAccount("RESTAURANT_REVENUE_PAYABLE")).toBe(1485n);
    expect(sumByAccount("PLATFORM_FEE_REVENUE")).toBe(15n);
    expect(sumByAccount("TIP_PAYABLE")).toBe(500n);
    expect(sumByAccount("REFUND_CONTRA")).toBe(2000n);

    const refunds = await prisma.refund.findMany({ where: { transactionId: transaction?.id } });
    expect(refunds.every((r) => r.tipRefunded)).toBe(true); // both events carried a nonzero tip share
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
    // ADR-023: 3 lines for the provisional loss (RESTAURANT_REVENUE_PAYABLE + PLATFORM_FEE_REVENUE
    // + REFUND_CONTRA — this Payment has a fee but no tip) + 3 for the mirrored reversal = 6.
    expect(chargebackLines).toHaveLength(6);
    const netRestaurantRevenue = chargebackLines
      .filter((l) => l.account === "RESTAURANT_REVENUE_PAYABLE")
      .reduce((sum, l) => sum + (l.direction === "CREDIT" ? l.amount : -l.amount), 0n);
    expect(netRestaurantRevenue).toBe(0n); // debited on open, credited back on WON — net zero
    const netFee = chargebackLines
      .filter((l) => l.account === "PLATFORM_FEE_REVENUE")
      .reduce((sum, l) => sum + (l.direction === "CREDIT" ? l.amount : -l.amount), 0n);
    expect(netFee).toBe(0n); // ADR-023: the fee is also clawed back and reversed on WON, not left standing
  });

  it("charge.dispute.created then charge.dispute.closed (won) with a tip (ADR-023): the provisional loss debits RESTAURANT_REVENUE_PAYABLE, PLATFORM_FEE_REVENUE, and the waiter's own TIP_PAYABLE credit proportionally, and WON reverses the exact same three amounts — discriminating: DATABASE.md claims 'Same compensating-entry rule as Refund', which was NOT true before this fix (only RESTAURANT_REVENUE_PAYABLE was ever touched)", async () => {
    const restaurant = await seedOrgRestaurant();
    const waiterMembership = await seedWaiterMembership(restaurant.organizationId, restaurant.id);
    const piId = `pi_${randomUUID()}`;
    // amount=2000, tipAmount=500 -> billAmount=1500 -> fee=15, revenue=1485 (1.00%).
    const payment = await seedPayment(restaurant.id, 2000n, piId, {
      tipAmount: 500n,
      waiterMembershipId: waiterMembership.id,
    });

    const { rawBody: succeededRaw, signature: succeededSig } = signEvent(
      buildEvent("payment_intent.succeeded", { id: piId, amount: 2000, currency: "eur" }),
    );
    await service.handleEvent(succeededRaw, succeededSig);
    const transaction = await prisma.transaction.findUnique({ where: { paymentId: payment.id } });

    const disputeId = `dp_${randomUUID()}`;
    const { rawBody: createdRaw, signature: createdSig } = signEvent(
      buildEvent("charge.dispute.created", {
        id: disputeId,
        payment_intent: piId,
        amount: 2000,
        reason: "fraudulent",
        status: "warning_needs_response",
        evidence_details: { due_by: null },
      }),
    );
    await service.handleEvent(createdRaw, createdSig);

    const chargeback = await prisma.chargeback.findFirst({
      where: { processorDisputeId: disputeId },
    });
    const provisionalEntry = await prisma.journalEntry.findFirst({
      where: { chargebackId: chargeback?.id, entryType: "CHARGEBACK" },
      orderBy: { createdAt: "asc" },
    });
    const provisionalLines = await prisma.ledgerLine.findMany({
      where: { journalEntryId: provisionalEntry?.id },
    });
    expect(provisionalLines.find((l) => l.account === "RESTAURANT_REVENUE_PAYABLE")?.amount).toBe(
      1485n,
    );
    expect(provisionalLines.find((l) => l.account === "PLATFORM_FEE_REVENUE")?.amount).toBe(15n);
    const provisionalTipLine = provisionalLines.find((l) => l.account === "TIP_PAYABLE");
    expect(provisionalTipLine?.amount).toBe(500n);
    expect(provisionalTipLine?.membershipId).toBe(waiterMembership.id); // never the null general line

    const { rawBody: closedRaw, signature: closedSig } = signEvent(
      buildEvent("charge.dispute.closed", {
        id: disputeId,
        payment_intent: piId,
        amount: 2000,
        reason: "fraudulent",
        status: "won",
        evidence_details: { due_by: null },
      }),
    );
    await service.handleEvent(closedRaw, closedSig);

    const allChargebackLines = await prisma.ledgerLine.findMany({
      where: { journalEntry: { transactionId: transaction?.id, entryType: "CHARGEBACK" } },
    });
    const netByAccount = (account: string) =>
      allChargebackLines
        .filter((l) => l.account === account)
        .reduce((sum, l) => sum + (l.direction === "CREDIT" ? l.amount : -l.amount), 0n);
    expect(netByAccount("RESTAURANT_REVENUE_PAYABLE")).toBe(0n);
    expect(netByAccount("PLATFORM_FEE_REVENUE")).toBe(0n);
    expect(netByAccount("TIP_PAYABLE")).toBe(0n); // the waiter's own credit is also fully reversed
    expect(netByAccount("REFUND_CONTRA")).toBe(0n); // opened as a credit, closed as a debit — net zero
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
    // ADR-023: 3 lines (RESTAURANT_REVENUE_PAYABLE + PLATFORM_FEE_REVENUE + REFUND_CONTRA — this
    // Payment has a fee but no tip), only the original provisional loss, no reversal.
    expect(chargebackLines).toHaveLength(3);
  });

  it("account.updated: delegates to RestaurantService.refreshStripeStatusByAccountId with the account id from the event", async () => {
    const accountId = `acct_${randomUUID()}`;
    const { rawBody, signature } = signEvent(buildEvent("account.updated", { id: accountId }));

    await service.handleEvent(rawBody, signature);

    expect(fakeRestaurantService.refreshStripeStatusByAccountId).toHaveBeenCalledWith(accountId);
  });
});
