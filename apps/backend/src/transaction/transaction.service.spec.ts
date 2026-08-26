import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { LedgerService } from "../ledger/ledger.service";
import { PrismaService } from "../prisma/prisma.service";
import type { RestaurantService } from "../restaurant/restaurant.service";
import { StripeService } from "../stripe/stripe.service";
import { IndividualTipAllocationStrategy } from "../tip/individual-tip-allocation.strategy";
import { WebhooksService } from "../webhooks/webhooks.service";
import { TransactionService } from "./transaction.service";

// Real database, driven through the REAL production write path (WebhooksService) — same
// discipline as every other real-Ledger spec file this project has. ADR-025's own claim (all
// four breakdown fields plus refundedAmount always sum to grossAmount) is checked here against
// real, webhook-produced LedgerLine rows, not hand-crafted fixtures.
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

describe("TransactionService (real database)", () => {
  const prisma = new PrismaService();
  let transactionService: TransactionService;
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
    const ledger = new LedgerService(prisma);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeConfig = { getOrThrow: () => 100 } as any; // 1.00%, Founder decision
    const fakeRestaurantService = {} as RestaurantService;
    webhooks = new WebhooksService(
      prisma,
      stripe,
      ledger,
      fakeRestaurantService,
      fakeConfig,
      new IndividualTipAllocationStrategy(),
    );
    transactionService = new TransactionService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedOrgRestaurant() {
    const org = await prisma.organization.create({ data: { name: "Transaction Test Org" } });
    const restaurant = await prisma.restaurant.create({
      data: {
        organizationId: org.id,
        name: "Transaction Test Restaurant",
        legalName: "Transaction Test Restaurant UAB",
        companyNumber: `TX-${randomUUID()}`,
        vatNumber: `LT${randomUUID()}`,
        email: `restaurant-${randomUUID()}@example.com`,
        phone: "+37060000010",
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
    const key = `transaction-test-key-${randomUUID()}`;
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

  function ownerUserReaching(organizationId: string): AuthenticatedUser {
    return {
      id: randomUUID(),
      email: "owner@example.com",
      locale: "en",
      memberships: [
        {
          id: randomUUID(),
          organizationId,
          restaurantId: null,
          role: { id: randomUUID(), name: "Owner", permissions: [] },
        },
      ],
    };
  }

  it(
    "DoD (IMPLEMENTATION_PLAN.md, Sprint 8): the breakdown sums exactly to grossAmount, before " +
      "AND after a full refund on a tip-bearing Transaction — discriminating: an implementation " +
      "that only reads PAYMENT_CAPTURED's own lines would show the pre-refund numbers forever, " +
      "never reflecting the refund at all",
    async () => {
      const { org, restaurant } = await seedOrgRestaurant();
      const waiterMembership = await seedWaiterMembership(org.id, restaurant.id);
      const piId = `pi_${randomUUID()}`;
      // amount=2000, tipAmount=500 -> billAmount=1500 -> fee=15, revenue=1485 (1.00%).
      const payment = await seedPayment(restaurant.id, 2000n, 500n, waiterMembership.id, piId);

      const { rawBody: succeededRaw, signature: succeededSig } = signEvent(
        buildEvent("payment_intent.succeeded", { id: piId, amount: 2000, currency: "eur" }),
      );
      await webhooks.handleEvent(succeededRaw, succeededSig);

      const transaction = await prisma.transaction.findUnique({ where: { paymentId: payment.id } });
      const user = ownerUserReaching(org.id);

      const beforeRefund = await transactionService.findOne(transaction!.id, user);
      expect(beforeRefund.netRestaurantRevenue).toBe("1485");
      expect(beforeRefund.netPlatformFee).toBe("15");
      expect(beforeRefund.netTip).toBe("500");
      expect(beforeRefund.tax).toBe("0");
      expect(beforeRefund.processingFee).toBeNull(); // ADR-025: never "0"
      expect(beforeRefund.refundedAmount).toBe("0");
      const sumBefore =
        BigInt(beforeRefund.netRestaurantRevenue) +
        BigInt(beforeRefund.netTip) +
        BigInt(beforeRefund.netPlatformFee) +
        BigInt(beforeRefund.tax) +
        BigInt(beforeRefund.refundedAmount);
      expect(sumBefore).toBe(2000n); // == grossAmount, exactly

      const { rawBody: refundRaw, signature: refundSig } = signEvent(
        buildEvent("charge.refunded", {
          id: `ch_${randomUUID()}`,
          payment_intent: piId,
          amount_refunded: 2000,
          refunds: { data: [{ id: `re_${randomUUID()}`, reason: "requested_by_customer" }] },
        }),
      );
      await webhooks.handleEvent(refundRaw, refundSig);

      const afterRefund = await transactionService.findOne(transaction!.id, user);
      // Every account nets to zero after a full refund — the whole point of ADR-025: this
      // reflects the CURRENT state, not the frozen capture-time snapshot.
      expect(afterRefund.netRestaurantRevenue).toBe("0");
      expect(afterRefund.netPlatformFee).toBe("0");
      expect(afterRefund.netTip).toBe("0");
      expect(afterRefund.refundedAmount).toBe("2000");
      const sumAfter =
        BigInt(afterRefund.netRestaurantRevenue) +
        BigInt(afterRefund.netTip) +
        BigInt(afterRefund.netPlatformFee) +
        BigInt(afterRefund.tax) +
        BigInt(afterRefund.refundedAmount);
      expect(sumAfter).toBe(2000n); // still == grossAmount, exactly, even after the refund
      expect(afterRefund.grossAmount).toBe("2000"); // Transaction.grossAmount itself never changes
      expect(afterRefund.status).toBe("REFUNDED");
      expect(afterRefund.refunds).toHaveLength(1);
      expect(afterRefund.refunds[0].tipRefunded).toBe(true);
    },
  );

  it("a Transaction with no tip: netTip is 0, no TIP_PAYABLE noise from the general liability line", async () => {
    const { org, restaurant } = await seedOrgRestaurant();
    const waiter = await seedWaiterMembership(org.id, restaurant.id);
    const piId = `pi_${randomUUID()}`;
    // ADR-022: waiterMembershipId is always captured regardless of tipAmount — a real Payment
    // never has both a null waiter and a zero tip's absence to explain; tipAmount=0 alone is
    // what makes this Transaction tip-less.
    const payment = await seedPayment(restaurant.id, 1000n, 0n, waiter.id, piId);

    const { rawBody, signature } = signEvent(
      buildEvent("payment_intent.succeeded", { id: piId, amount: 1000, currency: "eur" }),
    );
    await webhooks.handleEvent(rawBody, signature);

    const transaction = await prisma.transaction.findUnique({ where: { paymentId: payment.id } });
    const details = await transactionService.findOne(transaction!.id, ownerUserReaching(org.id));

    expect(details.netTip).toBe("0");
    expect(details.netRestaurantRevenue).toBe("990"); // 1000 at 1% fee
    expect(details.netPlatformFee).toBe("10");
    const sum =
      BigInt(details.netRestaurantRevenue) +
      BigInt(details.netTip) +
      BigInt(details.netPlatformFee) +
      BigInt(details.tax) +
      BigInt(details.refundedAmount);
    expect(sum).toBe(1000n);
  });

  it("findAllForUser: an unrelated Organization's Transactions never appear, even unfiltered", async () => {
    const { org: orgA, restaurant: restaurantA } = await seedOrgRestaurant();
    const { org: orgB, restaurant: restaurantB } = await seedOrgRestaurant();
    const waiterA = await seedWaiterMembership(orgA.id, restaurantA.id);
    const waiterB = await seedWaiterMembership(orgB.id, restaurantB.id);

    const piA = `pi_${randomUUID()}`;
    await seedPayment(restaurantA.id, 500n, 0n, waiterA.id, piA);
    const { rawBody: rawA, signature: sigA } = signEvent(
      buildEvent("payment_intent.succeeded", { id: piA, amount: 500, currency: "eur" }),
    );
    await webhooks.handleEvent(rawA, sigA);

    const piB = `pi_${randomUUID()}`;
    await seedPayment(restaurantB.id, 700n, 0n, waiterB.id, piB);
    const { rawBody: rawB, signature: sigB } = signEvent(
      buildEvent("payment_intent.succeeded", { id: piB, amount: 700, currency: "eur" }),
    );
    await webhooks.handleEvent(rawB, sigB);

    const page = await transactionService.findAllForUser(ownerUserReaching(orgA.id), {
      page: 1,
      limit: 20,
    });

    expect(page.data.every((t) => t.restaurantId === restaurantA.id)).toBe(true);
    expect(page.data.some((t) => t.grossAmount === "700")).toBe(false);
  });

  it("findOne throws NOT_FOUND for a Transaction outside the caller's reach", async () => {
    const { org, restaurant } = await seedOrgRestaurant();
    const waiter = await seedWaiterMembership(org.id, restaurant.id);
    const piId = `pi_${randomUUID()}`;
    await seedPayment(restaurant.id, 300n, 0n, waiter.id, piId);
    const { rawBody, signature } = signEvent(
      buildEvent("payment_intent.succeeded", { id: piId, amount: 300, currency: "eur" }),
    );
    await webhooks.handleEvent(rawBody, signature);
    const transaction = await prisma.transaction.findFirst({
      where: { payment: { processorPaymentId: piId } },
    });

    const { org: strangerOrg } = await seedOrgRestaurant();
    await expect(
      transactionService.findOne(transaction!.id, ownerUserReaching(strangerOrg.id)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("exportCsv produces a header plus one row per matching Transaction, omitting processingFee entirely", async () => {
    const { org, restaurant } = await seedOrgRestaurant();
    const waiter = await seedWaiterMembership(org.id, restaurant.id);
    const piId = `pi_${randomUUID()}`;
    await seedPayment(restaurant.id, 400n, 0n, waiter.id, piId);
    const { rawBody, signature } = signEvent(
      buildEvent("payment_intent.succeeded", { id: piId, amount: 400, currency: "eur" }),
    );
    await webhooks.handleEvent(rawBody, signature);

    const csv = await transactionService.exportCsv(ownerUserReaching(org.id), {});
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "id,restaurantId,grossAmount,currency,status,createdAt,netRestaurantRevenue,netTip,netPlatformFee,tax,refundedAmount",
    );
    expect(lines[0]).not.toContain("processingFee");
    expect(lines.some((l) => l.includes("400"))).toBe(true);
  });

  describe("findAllForUser: buildWhere filters actually narrow the result set", () => {
    it(
      "status filter: a REFUNDED Transaction appears when filtering status=REFUNDED, a " +
        "COMPLETED sibling in the same reachable scope does not — proves the filter is applied, " +
        "not merely present in the code",
      async () => {
        const { org, restaurant } = await seedOrgRestaurant();
        const waiter = await seedWaiterMembership(org.id, restaurant.id);
        const user = ownerUserReaching(org.id);

        const piCompleted = `pi_${randomUUID()}`;
        await seedPayment(restaurant.id, 900n, 0n, waiter.id, piCompleted);
        const { rawBody: rawCompleted, signature: sigCompleted } = signEvent(
          buildEvent("payment_intent.succeeded", { id: piCompleted, amount: 900, currency: "eur" }),
        );
        await webhooks.handleEvent(rawCompleted, sigCompleted);

        const piRefunded = `pi_${randomUUID()}`;
        await seedPayment(restaurant.id, 1100n, 0n, waiter.id, piRefunded);
        const { rawBody: rawRefunded, signature: sigRefunded } = signEvent(
          buildEvent("payment_intent.succeeded", { id: piRefunded, amount: 1100, currency: "eur" }),
        );
        await webhooks.handleEvent(rawRefunded, sigRefunded);
        const { rawBody: rawRefund, signature: sigRefund } = signEvent(
          buildEvent("charge.refunded", {
            id: `ch_${randomUUID()}`,
            payment_intent: piRefunded,
            amount_refunded: 1100,
            refunds: { data: [{ id: `re_${randomUUID()}`, reason: "requested_by_customer" }] },
          }),
        );
        await webhooks.handleEvent(rawRefund, sigRefund);

        const filtered = await transactionService.findAllForUser(user, {
          status: "REFUNDED",
          page: 1,
          limit: 20,
        });

        expect(filtered.data.every((t) => t.grossAmount !== "900")).toBe(true); // COMPLETED one excluded
        expect(filtered.data.some((t) => t.grossAmount === "1100")).toBe(true); // REFUNDED one included
        expect(filtered.data.every((t) => t.status === "REFUNDED")).toBe(true);
      },
    );

    it(
      "membership filter: a waiter's own Transaction appears when filtering by their " +
        "membershipId, a colleague's does not — proves ?membership= actually scopes to that " +
        "one person, not just accepted as a query param",
      async () => {
        const { org, restaurant } = await seedOrgRestaurant();
        const waiterA = await seedWaiterMembership(org.id, restaurant.id);
        const waiterB = await seedWaiterMembership(org.id, restaurant.id);
        const user = ownerUserReaching(org.id);

        const piA = `pi_${randomUUID()}`;
        await seedPayment(restaurant.id, 600n, 0n, waiterA.id, piA);
        const { rawBody: rawA, signature: sigA } = signEvent(
          buildEvent("payment_intent.succeeded", { id: piA, amount: 600, currency: "eur" }),
        );
        await webhooks.handleEvent(rawA, sigA);

        const piB = `pi_${randomUUID()}`;
        await seedPayment(restaurant.id, 800n, 0n, waiterB.id, piB);
        const { rawBody: rawB, signature: sigB } = signEvent(
          buildEvent("payment_intent.succeeded", { id: piB, amount: 800, currency: "eur" }),
        );
        await webhooks.handleEvent(rawB, sigB);

        const filtered = await transactionService.findAllForUser(user, {
          membership: waiterA.id,
          page: 1,
          limit: 20,
        });

        expect(filtered.data.some((t) => t.grossAmount === "600")).toBe(true); // waiterA's own
        expect(filtered.data.every((t) => t.grossAmount !== "800")).toBe(true); // waiterB's excluded
      },
    );
  });

  it(
    "findOne: a Chargeback on the Transaction appears in the response with the correct shape " +
      "(id, amount, reason, status, resolvedAt, createdAt) — the mapping itself, distinct from " +
      "the breakdown arithmetic already proven in webhooks.service.spec.ts",
    async () => {
      const { org, restaurant } = await seedOrgRestaurant();
      const waiter = await seedWaiterMembership(org.id, restaurant.id);
      const piId = `pi_${randomUUID()}`;
      await seedPayment(restaurant.id, 3000n, 0n, waiter.id, piId);
      const { rawBody: succeededRaw, signature: succeededSig } = signEvent(
        buildEvent("payment_intent.succeeded", { id: piId, amount: 3000, currency: "eur" }),
      );
      await webhooks.handleEvent(succeededRaw, succeededSig);
      const transaction = await prisma.transaction.findFirstOrThrow({
        where: { payment: { processorPaymentId: piId } },
      });

      const disputeId = `dp_${randomUUID()}`;
      const { rawBody: disputeRaw, signature: disputeSig } = signEvent(
        buildEvent("charge.dispute.created", {
          id: disputeId,
          payment_intent: piId,
          amount: 3000,
          reason: "fraudulent",
          status: "warning_needs_response",
          evidence_details: { due_by: null },
        }),
      );
      await webhooks.handleEvent(disputeRaw, disputeSig);

      const details = await transactionService.findOne(transaction.id, ownerUserReaching(org.id));

      expect(details.chargebacks).toHaveLength(1);
      const chargeback = details.chargebacks[0];
      expect(chargeback.amount).toBe("3000");
      expect(chargeback.reason).toBe("fraudulent");
      expect(chargeback.status).toBe("UNDER_REVIEW");
      expect(chargeback.resolvedAt).toBeNull(); // still under review — not resolved yet
      expect(chargeback.id).toEqual(expect.any(String));
      expect(chargeback.createdAt).toBeInstanceOf(Date);
    },
  );
});
