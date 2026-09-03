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
import { DashboardService } from "./dashboard.service";

// Real database, driven through the REAL production write path (WebhooksService) — same
// discipline as transaction.service.spec.ts / wallet-projection.service.spec.ts. Sprint 9's own
// DoD: "Dashboard figures match a manual sum over LedgerLine" — checked directly against a raw
// groupBy in several tests below, not just against the service's own output.
const WEBHOOK_SECRET = "whsec_test_fake_secret_for_signing_only";
const TIMEZONE = "Europe/Vilnius";

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

describe("DashboardService (real database)", () => {
  const prisma = new PrismaService();
  let dashboardService: DashboardService;
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
    dashboardService = new DashboardService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedOrgRestaurant() {
    const org = await prisma.organization.create({ data: { name: "Dashboard Test Org" } });
    const restaurant = await prisma.restaurant.create({
      data: {
        organizationId: org.id,
        name: "Dashboard Test Restaurant",
        legalName: "Dashboard Test Restaurant UAB",
        companyNumber: `DB-${randomUUID()}`,
        vatNumber: `LT${randomUUID()}`,
        email: `restaurant-${randomUUID()}@example.com`,
        phone: "+37060000020",
        country: "LT",
        currency: "EUR",
        defaultCustomerLocale: "en",
        timezone: TIMEZONE,
        address: "Test address",
        stripeAccountId: `acct_fake_${randomUUID()}`,
      },
    });
    return { org, restaurant };
  }

  async function seedMembership(
    organizationId: string,
    restaurantId: string | null,
    roleName: "Owner" | "Waiter",
  ) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
    const user = await prisma.user.create({
      data: {
        email: `${roleName.toLowerCase()}-${randomUUID()}@example.com`,
        displayName: `Test ${roleName}`,
        passwordHash: "not-a-real-hash",
        locale: "en",
      },
    });
    const membership = await prisma.membership.create({
      data: { userId: user.id, organizationId, restaurantId, roleId: role.id },
    });
    return { user, membership };
  }

  async function seedPayment(
    restaurantId: string,
    amount: bigint,
    tipAmount: bigint,
    waiterMembershipId: string,
    processorPaymentId: string,
  ) {
    const key = `dashboard-test-key-${randomUUID()}`;
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

  async function capture(
    restaurantId: string,
    amount: bigint,
    tipAmount: bigint,
    waiterMembershipId: string,
  ) {
    const piId = `pi_${randomUUID()}`;
    const payment = await seedPayment(restaurantId, amount, tipAmount, waiterMembershipId, piId);
    const { rawBody, signature } = signEvent(
      buildEvent("payment_intent.succeeded", { id: piId, amount: Number(amount), currency: "eur" }),
    );
    await webhooks.handleEvent(rawBody, signature);
    const transaction = await prisma.transaction.findUniqueOrThrow({
      where: { paymentId: payment.id },
    });
    return { payment, transaction, piId };
  }

  async function refundFull(piId: string, amount: bigint) {
    const { rawBody, signature } = signEvent(
      buildEvent("charge.refunded", {
        id: `ch_${randomUUID()}`,
        payment_intent: piId,
        amount_refunded: Number(amount),
        refunds: { data: [{ id: `re_${randomUUID()}`, reason: "requested_by_customer" }] },
      }),
    );
    await webhooks.handleEvent(rawBody, signature);
  }

  /** ADR-062: a REFUND can no longer produce a TIP_PAYABLE debit — it returns the bill and the
   * tip stays with the waiter. A CHARGEBACK still can, and deliberately: the bank reverses the
   * whole charge, tip included, and that rule is open (ADR-062, THREAT_MODEL). So the netting
   * case below is now built from a dispute, the only event that still debits a waiter's tip. */
  async function disputeFull(piId: string, amount: bigint) {
    const { rawBody, signature } = signEvent(
      buildEvent("charge.dispute.created", {
        id: `dp_${randomUUID()}`,
        payment_intent: piId,
        amount: Number(amount),
        reason: "fraudulent",
        status: "needs_response",
      }),
    );
    await webhooks.handleEvent(rawBody, signature);
  }

  /** Backdates every LedgerLine belonging to `transactionId` by `daysAgo` full days — simulates
   * "this financial event actually happened N days ago," which the real webhook write path has
   * no way to do directly (createdAt always defaults to now()). Needed to construct the
   * discriminating day-boundary cases below. */
  async function backdateLedgerLines(transactionId: string, daysAgo: number): Promise<void> {
    const lines = await prisma.ledgerLine.findMany({
      where: { journalEntry: { transactionId } },
      select: { id: true, createdAt: true },
    });
    await Promise.all(
      lines.map((l) =>
        prisma.ledgerLine.update({
          where: { id: l.id },
          data: { createdAt: new Date(l.createdAt.getTime() - daysAgo * 24 * 60 * 60 * 1000) },
        }),
      ),
    );
  }

  function userReaching(
    organizationId: string,
    role: "Owner" | "Waiter" = "Owner",
  ): AuthenticatedUser {
    return {
      id: randomUUID(),
      email: "caller@example.com",
      locale: "en",
      memberships: [
        {
          id: randomUUID(),
          organizationId,
          restaurantId: null,
          role: {
            id: randomUUID(),
            name: role,
            permissions: role === "Owner" ? ["reports.view"] : [],
          },
        },
      ],
    };
  }

  it(
    "DoD (IMPLEMENTATION_PLAN.md, Sprint 9): today's figures match a manual SUM(CREDIT)-SUM(DEBIT) " +
      "over LedgerLine, and correctly EXCLUDE a payment backdated to yesterday",
    async () => {
      const { org, restaurant } = await seedOrgRestaurant();
      const { membership: waiter } = await seedMembership(org.id, restaurant.id, "Waiter");

      // amount=2000, tipAmount=500 -> billAmount=1500 -> fee=15 (1%), revenue=1485.
      const { transaction: todayTx } = await capture(restaurant.id, 2000n, 500n, waiter.id);
      // A second payment, backdated to yesterday — must NOT appear in today's totals at all.
      const { transaction: yesterdayTx } = await capture(restaurant.id, 9000n, 0n, waiter.id);
      await backdateLedgerLines(yesterdayTx.id, 1);

      const summary = await dashboardService.getSummary(restaurant.id, userReaching(org.id));

      expect(summary.todayRevenue).toBe("1500"); // 1485 + 15, from todayTx only
      expect(summary.todayTips).toBe("500");
      // ADR-026: todayRevenue is gross sales, not netRestaurantRevenue (ADR-025) — the difference
      // must be explicit on screen, not only in documentation.
      expect(summary.todayRevenueNote).toBe("Before platform fee deduction");

      // Manual recomputation directly from LedgerLine, independent of the service's own code
      // path — DoD's own wording ("matches a manual sum over LedgerLine"), scoped to just
      // todayTx's own lines since that's the only Transaction actually dated today.
      const windowed = await prisma.ledgerLine.groupBy({
        by: ["account", "direction"],
        where: {
          restaurantId: restaurant.id,
          account: { in: ["RESTAURANT_REVENUE_PAYABLE", "PLATFORM_FEE_REVENUE"] },
          journalEntry: { transactionId: todayTx.id },
        },
        _sum: { amount: true },
      });
      const net = (account: string, direction: "CREDIT" | "DEBIT") =>
        windowed.find((g) => g.account === account && g.direction === direction)?._sum.amount ?? 0n;
      const manualRevenue =
        net("RESTAURANT_REVENUE_PAYABLE", "CREDIT") -
        net("RESTAURANT_REVENUE_PAYABLE", "DEBIT") +
        (net("PLATFORM_FEE_REVENUE", "CREDIT") - net("PLATFORM_FEE_REVENUE", "DEBIT"));
      expect(manualRevenue.toString()).toBe(summary.todayRevenue);
    },
  );

  it(
    "a refund posted TODAY against a payment from a PRIOR day reduces TODAY's totals, not the " +
      "prior day's — the discriminating case for day-boundary-by-LedgerLine.createdAt, not by " +
      "Transaction.createdAt",
    async () => {
      const { org, restaurant } = await seedOrgRestaurant();
      const { membership: waiter } = await seedMembership(org.id, restaurant.id, "Waiter");

      const { transaction, piId } = await capture(restaurant.id, 2000n, 0n, waiter.id);
      await backdateLedgerLines(transaction.id, 1); // the sale "happened yesterday"

      // Refund happens now (today) — its own LedgerLine rows are NOT backdated.
      await refundFull(piId, 2000n);

      const summary = await dashboardService.getSummary(restaurant.id, userReaching(org.id));
      // Today has no sale of its own, but does have a refund dated today: net effect is negative.
      expect(BigInt(summary.todayRevenue)).toBe(-2000n);
    },
  );

  it(
    "Average Tip is the ratio of SUMS, not the average of individual per-transaction ratios — " +
      "the Founder's own explicit correction",
    async () => {
      const { org, restaurant } = await seedOrgRestaurant();
      const { membership: waiter } = await seedMembership(org.id, restaurant.id, "Waiter");
      // Payment A: bill=100, tip=50 (50% individually). Payment B: bill=1000, tip=50 (5%
      // individually). Naive average-of-ratios = 27.5%. Correct ratio-of-sums = 100/1100 ≈ 9.09%.
      await capture(restaurant.id, 150n, 50n, waiter.id); // billAmount=100, tip=50
      await capture(restaurant.id, 1050n, 50n, waiter.id); // billAmount=1000, tip=50

      const summary = await dashboardService.getSummary(restaurant.id, userReaching(org.id));
      expect(summary.todayTips).toBe("100");
      // todayRevenue = SUM(billAmount) net of fee-inclusive accounts = 100+1000 = 1100 (fee stays
      // inside RESTAURANT_REVENUE_PAYABLE+PLATFORM_FEE_REVENUE regardless of rate).
      expect(summary.todayRevenue).toBe("1100");
      const basisPoints = BigInt(summary.averageTipBasisPoints!);
      expect(basisPoints).toBe((100n * 10_000n) / 1100n); // 909, i.e. 9.09% — not 2750 (27.5%)
      expect(basisPoints).not.toBe(2750n);
    },
  );

  it('Average Tip is null, never "0", when today has no revenue at all', async () => {
    const { org, restaurant } = await seedOrgRestaurant();
    const summary = await dashboardService.getSummary(restaurant.id, userReaching(org.id));
    expect(summary.todayRevenue).toBe("0");
    expect(summary.averageTipBasisPoints).toBeNull();
  });

  it(
    'averageBill is null — never "0" — when there were no transactions today, and ' +
      "todayTransactions is 0: the discriminating case against both naive implementations, one " +
      "that divides by zero and one that reports an average of nothing as an average of zero",
    async () => {
      const { org, restaurant } = await seedOrgRestaurant();

      const summary = await dashboardService.getSummary(restaurant.id, userReaching(org.id));

      // A division-by-zero implementation throws before reaching this line; a "return 0"
      // implementation reaches it and fails on the value. Both are wrong for the same reason:
      // there is no divisor, so there is no average — "no bills today" is not "a bill of zero".
      expect(summary.averageBill).toBeNull();
      expect(summary.todayTransactions).toBe(0);
    },
  );

  it(
    "todayTransactions counts today's SALES and averageBill divides today's revenue by them — " +
      "discriminating: two sales of different sizes, so an implementation returning either sale's " +
      "own amount, or the plain sum, disagrees with the ratio-of-sums answer",
    async () => {
      const { org, restaurant } = await seedOrgRestaurant();
      const { membership: waiter } = await seedMembership(org.id, restaurant.id, "Waiter");

      // Bills of 1000 and 3000 (no tips, so revenue is the bill exactly): revenue 4000 over
      // 2 sales = 2000. Neither 1000 nor 3000 nor 4000 — the ratio is its own number here.
      await capture(restaurant.id, 1000n, 0n, waiter.id);
      await capture(restaurant.id, 3000n, 0n, waiter.id);

      const summary = await dashboardService.getSummary(restaurant.id, userReaching(org.id));

      expect(summary.todayTransactions).toBe(2);
      expect(BigInt(summary.todayRevenue)).toBe(4000n);
      expect(summary.averageBill).toBe("2000");
    },
  );

  it(
    "a refund posted today against a PRIOR day's sale moves today's revenue but NOT " +
      "todayTransactions — the count is of sales made today, not of ledger activity dated today",
    async () => {
      const { org, restaurant } = await seedOrgRestaurant();
      const { membership: waiter } = await seedMembership(org.id, restaurant.id, "Waiter");

      const { transaction, piId } = await capture(restaurant.id, 2000n, 0n, waiter.id);
      await backdateLedgerLines(transaction.id, 1); // the sale happened yesterday
      await refundFull(piId, 2000n); // the refund is dated today

      const summary = await dashboardService.getSummary(restaurant.id, userReaching(org.id));

      // Today's revenue is negative — ADR-026's own rule, and UX_MAP requires the screen to
      // render it rather than clamp it.
      expect(BigInt(summary.todayRevenue)).toBe(-2000n);
      // But no sale happened today, so there is nothing to average and nothing to count. An
      // implementation counting REFUND_ISSUED entries, or any ledger activity, would say 1 here
      // and hand the screen an "average bill" of -2000 for a day with no bills.
      expect(summary.todayTransactions).toBe(0);
      expect(summary.averageBill).toBeNull();
    },
  );

  it(
    "Top Staff nets TIP_PAYABLE via SUM(CREDIT)-SUM(DEBIT), not a naive sum of TIP_ALLOCATED " +
      "credits alone — a same-day CHARGEBACK on a tip-bearing payment must not overstate the " +
      "waiter's collected tips (ADR-023's own bug class; since ADR-062 a refund cannot build " +
      "this case at all, which is why the discriminating event here is a dispute)",
    async () => {
      const { org, restaurant } = await seedOrgRestaurant();
      const { user: waiterUser, membership: waiter } = await seedMembership(
        org.id,
        restaurant.id,
        "Waiter",
      );
      const { piId } = await capture(restaurant.id, 2000n, 500n, waiter.id);
      // Same day, and a dispute rather than a refund: under ADR-062 a refund of the gross is
      // refused outright (REFUND_EXCEEDS_BILL) and a refund of the bill never touches the tip,
      // so a refund can no longer construct the overstatement this test exists to catch.
      await disputeFull(piId, 2000n);

      const summary = await dashboardService.getSummary(restaurant.id, userReaching(org.id));
      const entry = summary.topStaff.find((s) => s.membershipId === waiter.id);
      // A naive "sum only TIP_ALLOCATED credits" implementation would report "500" here — wrong,
      // since the chargeback reversed the tip the same day. Correct net is exactly 0.
      if (entry) {
        expect(entry.tips).toBe("0");
      } else {
        // Also acceptable: net-zero entries simply don't appear (both are "not overstated").
        expect(summary.topStaff.some((s) => s.membershipId === waiter.id)).toBe(false);
      }
      expect(waiterUser.email).toContain("waiter-"); // sanity: seeded as expected
    },
  );

  it("Top Staff ranks a real net-positive tip correctly and surfaces BOTH the staff member's display name and email", async () => {
    const { org, restaurant } = await seedOrgRestaurant();
    const { user: waiterUser, membership: waiter } = await seedMembership(
      org.id,
      restaurant.id,
      "Waiter",
    );
    await capture(restaurant.id, 1500n, 500n, waiter.id);

    const summary = await dashboardService.getSummary(restaurant.id, userReaching(org.id));
    const entry = summary.topStaff.find((s) => s.membershipId === waiter.id);
    expect(entry).toBeDefined();
    expect(entry!.tips).toBe("500");
    expect(entry!.email).toBe(waiterUser.email);
    // ADR-026 shipped this screen with email only, correctly recording at the time that `User`
    // had no name field. ADR-033 then added `displayName` and nothing came back here, so a screen
    // whose whole job is naming people kept showing addresses. Asserted rather than assumed, and
    // asserted as a DISTINCT value from the email — an implementation that filled displayName from
    // the email (an easy "fix") would pass a mere `toBeDefined()` and fail this.
    expect(entry!.displayName).toBe(waiterUser.displayName);
    expect(entry!.displayName).not.toBe(entry!.email);
  });

  it("Revenue Chart buckets a 3-days-ago payment into the correct day, not today's", async () => {
    const { org, restaurant } = await seedOrgRestaurant();
    const { membership: waiter } = await seedMembership(org.id, restaurant.id, "Waiter");
    const { transaction } = await capture(restaurant.id, 3000n, 0n, waiter.id);
    await backdateLedgerLines(transaction.id, 3);

    const summary = await dashboardService.getSummary(restaurant.id, userReaching(org.id));
    expect(summary.revenueChart).toHaveLength(7);
    expect(summary.revenueChart[6].revenue).toBe(summary.todayRevenue); // last point == today
    expect(summary.revenueChart[6].revenue).toBe("0"); // today itself had no sale
    const threeDaysAgoPoint = summary.revenueChart[3]; // index 6-3
    expect(threeDaysAgoPoint.revenue).toBe("3000");
  });

  it("throws PERMISSION_DENIED for a Waiter (no reports.view), not a silent empty dashboard", async () => {
    const { org, restaurant } = await seedOrgRestaurant();
    await expect(
      dashboardService.getSummary(restaurant.id, userReaching(org.id, "Waiter")),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("throws RESTAURANT_NOT_FOUND for a caller from an unrelated Organization — never leaks existence", async () => {
    const { restaurant } = await seedOrgRestaurant();
    const { org: strangerOrg } = await seedOrgRestaurant();
    await expect(
      dashboardService.getSummary(restaurant.id, userReaching(strangerOrg.id)),
    ).rejects.toMatchObject({ code: "RESTAURANT_NOT_FOUND" });
  });
});
