import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { getLocalDayWindow } from "../common/timezone-day.util";
import { LedgerService } from "../ledger/ledger.service";
import { PrismaService } from "../prisma/prisma.service";
import type { RestaurantService } from "../restaurant/restaurant.service";
import { StripeService } from "../stripe/stripe.service";
import { IndividualTipAllocationStrategy } from "../tip/individual-tip-allocation.strategy";
import { WebhooksService } from "../webhooks/webhooks.service";
import { AnalyticsService } from "./analytics.service";
import {
  analyticsQuerySchema,
  reportsQuerySchema,
  staffAnalyticsQuerySchema,
} from "./dto/analytics-query.schema";

// Real database, driven through the REAL production write path (WebhooksService) — same
// discipline as dashboard.service.spec.ts / transaction.service.spec.ts. IMPLEMENTATION_PLAN.md's
// own Sprint 10 DoD: "Every analytics figure is reproducible from LedgerLine."
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

/** "N days ago" as the YYYY-MM-DD string the app itself would compute for `TIMEZONE` — reusing
 * the already-independently-tested getLocalDayWindow rather than re-deriving date arithmetic here,
 * so query `from`/`to` values always line up with what backdateLedgerLines actually produces. */
function dateNDaysAgo(n: number): string {
  return getLocalDayWindow(TIMEZONE, n).date;
}

describe("AnalyticsService (real database)", () => {
  const prisma = new PrismaService();
  let analyticsService: AnalyticsService;
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
    analyticsService = new AnalyticsService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedOrgRestaurant() {
    const org = await prisma.organization.create({ data: { name: "Analytics Test Org" } });
    const restaurant = await prisma.restaurant.create({
      data: {
        organizationId: org.id,
        name: "Analytics Test Restaurant",
        legalName: "Analytics Test Restaurant UAB",
        companyNumber: `AN-${randomUUID()}`,
        vatNumber: `LT${randomUUID()}`,
        email: `restaurant-${randomUUID()}@example.com`,
        phone: "+37060000030",
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
    const key = `analytics-test-key-${randomUUID()}`;
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

  /** Backdates every LedgerLine belonging to `transactionId` by `daysAgo` full days — same
   * technique as dashboard.service.spec.ts, needed to construct multi-day date-range fixtures the
   * real webhook write path has no direct way to produce (createdAt always defaults to now()). */
  async function backdateLedgerLines(transactionId: string, daysAgo: number): Promise<void> {
    if (daysAgo === 0) return;
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
    permissions: string[] = ["reports.view", "data.export"],
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
          role: { id: randomUUID(), name: "Owner", permissions },
        },
      ],
    };
  }

  describe("Revenue/Tips: date-range series bucketing", () => {
    it(
      "buckets each day's own captures into their own series entry, in ascending date order — " +
        "not merged into one total and not shifted to the wrong day",
      async () => {
        const { org, restaurant } = await seedOrgRestaurant();
        const { membership: waiter } = await seedMembership(org.id, restaurant.id, "Waiter");

        // billAmount=300/tip=30, billAmount=700/tip=70, billAmount=1100/tip=110 — three days apart.
        const { transaction: twoDaysAgoTx } = await capture(restaurant.id, 330n, 30n, waiter.id);
        await backdateLedgerLines(twoDaysAgoTx.id, 2);
        const { transaction: oneDayAgoTx } = await capture(restaurant.id, 770n, 70n, waiter.id);
        await backdateLedgerLines(oneDayAgoTx.id, 1);
        await capture(restaurant.id, 1210n, 110n, waiter.id); // today, not backdated

        const from = dateNDaysAgo(2);
        const to = dateNDaysAgo(0);
        const revenue = await analyticsService.getRevenue(
          { restaurantId: restaurant.id, from, to },
          userReaching(org.id),
        );
        const tips = await analyticsService.getTips(
          { restaurantId: restaurant.id, from, to },
          userReaching(org.id),
        );

        expect(revenue.series).toHaveLength(3);
        expect(revenue.series[0]).toEqual({ date: dateNDaysAgo(2), amount: "300" });
        expect(revenue.series[1]).toEqual({ date: dateNDaysAgo(1), amount: "700" });
        expect(revenue.series[2]).toEqual({ date: dateNDaysAgo(0), amount: "1100" });
        expect(revenue.total).toBe("2100");
        expect(revenue.totalNote).toBe("Before platform fee deduction");

        expect(tips.series[0]).toEqual({ date: dateNDaysAgo(2), amount: "30" });
        expect(tips.series[1]).toEqual({ date: dateNDaysAgo(1), amount: "70" });
        expect(tips.series[2]).toEqual({ date: dateNDaysAgo(0), amount: "110" });
        expect(tips.total).toBe("210");
      },
    );
  });

  describe("Staff: full-list pagination and ranking", () => {
    it(
      "ranks by net tips descending and paginates correctly — page 2 is NOT a repeat of page 1, " +
        "and meta.total/pages reflect the full unpaginated count",
      async () => {
        const { org, restaurant } = await seedOrgRestaurant();
        const { membership: waiterA } = await seedMembership(org.id, restaurant.id, "Waiter");
        const { membership: waiterB } = await seedMembership(org.id, restaurant.id, "Waiter");
        const { membership: waiterC } = await seedMembership(org.id, restaurant.id, "Waiter");
        await capture(restaurant.id, 1300n, 300n, waiterA.id); // tips=300
        await capture(restaurant.id, 1200n, 200n, waiterB.id); // tips=200
        await capture(restaurant.id, 1100n, 100n, waiterC.id); // tips=100

        const from = dateNDaysAgo(0);
        const to = dateNDaysAgo(0);
        const user = userReaching(org.id);

        const page1 = await analyticsService.getStaff(
          { restaurantId: restaurant.id, from, to, page: 1, limit: 2 },
          user,
        );
        expect(page1.data.map((e) => e.tips)).toEqual(["300", "200"]);
        expect(page1.meta).toEqual({ page: 1, limit: 2, total: 3, pages: 2 });

        const page2 = await analyticsService.getStaff(
          { restaurantId: restaurant.id, from, to, page: 2, limit: 2 },
          user,
        );
        expect(page2.data.map((e) => e.tips)).toEqual(["100"]);
        expect(page2.meta).toEqual({ page: 2, limit: 2, total: 3, pages: 2 });
      },
    );
  });

  describe("Performance: period-over-period comparison", () => {
    it(
      "the previous period is the immediately preceding period of the SAME length (inclusive-day " +
        "counting) — a naive exclusive day-count would compute a 2-day previous period here and " +
        "miss the 5-days-ago capture entirely",
      async () => {
        const { org, restaurant } = await seedOrgRestaurant();
        const { membership: waiter } = await seedMembership(org.id, restaurant.id, "Waiter");

        // Current period: 3-day range [2 days ago .. today]. Only "2 days ago" has data.
        const { transaction: currentTx } = await capture(restaurant.id, 1000n, 0n, waiter.id);
        await backdateLedgerLines(currentTx.id, 2);

        // Previous period (correct, inclusive counting): [5 days ago .. 3 days ago]. Only
        // "5 days ago" has data — a naive exclusive-day-count bug would compute previousFrom as
        // "4 days ago" instead of "5 days ago" and silently drop this capture from the total.
        const { transaction: previousTx } = await capture(restaurant.id, 555n, 0n, waiter.id);
        await backdateLedgerLines(previousTx.id, 5);

        const from = dateNDaysAgo(2);
        const to = dateNDaysAgo(0);
        const perf = await analyticsService.getPerformance(
          { restaurantId: restaurant.id, from, to },
          userReaching(org.id),
        );

        expect(perf.currentPeriod.revenue).toBe("1000");
        expect(perf.previousPeriod.revenue).toBe("555");
        expect(perf.previousPeriod.from).toBe(dateNDaysAgo(5));
        expect(perf.previousPeriod.to).toBe(dateNDaysAgo(3));
        expect(perf.changeBasisPoints.revenue).toBe((((1000n - 555n) * 10_000n) / 555n).toString());
      },
    );

    it("changeBasisPoints is null, never a fabricated 0, when the previous period had zero revenue", async () => {
      const { org, restaurant } = await seedOrgRestaurant();
      const { membership: waiter } = await seedMembership(org.id, restaurant.id, "Waiter");
      await capture(restaurant.id, 500n, 0n, waiter.id); // today only, previous period stays empty

      const from = dateNDaysAgo(0);
      const to = dateNDaysAgo(0);
      const perf = await analyticsService.getPerformance(
        { restaurantId: restaurant.id, from, to },
        userReaching(org.id),
      );
      expect(perf.previousPeriod.revenue).toBe("0");
      expect(perf.changeBasisPoints.revenue).toBeNull();
    });
  });

  describe("Reports: period-summary", () => {
    it(
      "averageTipBasisPoints is the ratio of SUMS, not an average of per-transaction ratios — same " +
        "discriminating case as Dashboard's Average Tip (ADR-026)",
      async () => {
        const { org, restaurant } = await seedOrgRestaurant();
        const { membership: waiter } = await seedMembership(org.id, restaurant.id, "Waiter");
        await capture(restaurant.id, 150n, 50n, waiter.id); // billAmount=100, tip=50 (50%)
        await capture(restaurant.id, 1050n, 50n, waiter.id); // billAmount=1000, tip=50 (5%)

        const from = dateNDaysAgo(0);
        const to = dateNDaysAgo(0);
        const report = await analyticsService.getReport(
          { restaurantId: restaurant.id, from, to, type: "period-summary" },
          userReaching(org.id),
        );

        expect(report.type).toBe("period-summary");
        expect(report.revenue).toBe("1100");
        expect(report.tips).toBe("100");
        expect(report.transactionCount).toBe(2);
        const basisPoints = BigInt(report.averageTipBasisPoints!);
        expect(basisPoints).toBe((100n * 10_000n) / 1100n); // 909 — not 2750 (naive average of 50%/5%)
        expect(basisPoints).not.toBe(2750n);
      },
    );

    it("topStaff is capped at 5 and correctly ranks by net tips, dropping the 6th-highest", async () => {
      const { org, restaurant } = await seedOrgRestaurant();
      const amounts = [600n, 500n, 400n, 300n, 200n, 100n];
      for (const tip of amounts) {
        const { membership: w } = await seedMembership(org.id, restaurant.id, "Waiter");
        await capture(restaurant.id, 1000n + tip, tip, w.id);
      }

      const from = dateNDaysAgo(0);
      const to = dateNDaysAgo(0);
      const report = await analyticsService.getReport(
        { restaurantId: restaurant.id, from, to, type: "period-summary" },
        userReaching(org.id),
      );

      expect(report.topStaff).toHaveLength(5);
      expect(report.topStaff.map((s) => s.tips)).toEqual(["600", "500", "400", "300", "200"]);
      expect(report.topStaff.some((s) => s.tips === "100")).toBe(false);
    });
  });

  describe("CSV exports: header + row shape", () => {
    it("exportRevenueCsv produces a date,amount header with one row per series day", async () => {
      const { org, restaurant } = await seedOrgRestaurant();
      const { membership: waiter } = await seedMembership(org.id, restaurant.id, "Waiter");
      await capture(restaurant.id, 400n, 0n, waiter.id);

      const from = dateNDaysAgo(0);
      const to = dateNDaysAgo(0);
      const csv = await analyticsService.exportRevenueCsv(
        { restaurantId: restaurant.id, from, to },
        userReaching(org.id),
      );
      const lines = csv.split("\n");
      expect(lines[0]).toBe("date,amount");
      expect(lines[1]).toBe(`${dateNDaysAgo(0)},400`);
    });

    it("exportStaffCsv produces a membershipId,email,tips header, unpaginated (every row)", async () => {
      const { org, restaurant } = await seedOrgRestaurant();
      const { user: waiterUser, membership: waiter } = await seedMembership(
        org.id,
        restaurant.id,
        "Waiter",
      );
      await capture(restaurant.id, 1500n, 500n, waiter.id);

      const from = dateNDaysAgo(0);
      const to = dateNDaysAgo(0);
      const csv = await analyticsService.exportStaffCsv(
        { restaurantId: restaurant.id, from, to },
        userReaching(org.id),
      );
      const lines = csv.split("\n");
      expect(lines[0]).toBe("membershipId,email,tips");
      expect(lines[1]).toBe(`${waiter.id},${waiterUser.email},500`);
    });

    it("exportReportCsv produces flat scalar fields only — no nested topStaff section", async () => {
      const { org, restaurant } = await seedOrgRestaurant();
      const { membership: waiter } = await seedMembership(org.id, restaurant.id, "Waiter");
      await capture(restaurant.id, 1100n, 100n, waiter.id);

      const from = dateNDaysAgo(0);
      const to = dateNDaysAgo(0);
      const csv = await analyticsService.exportReportCsv(
        { restaurantId: restaurant.id, from, to, type: "period-summary" },
        userReaching(org.id),
      );
      const lines = csv.split("\n");
      expect(lines[0]).toBe(
        "restaurantId,from,to,type,revenue,tips,averageTipBasisPoints,transactionCount",
      );
      expect(lines).toHaveLength(2); // header + exactly one row, never a topStaff section
    });
  });

  describe("Permission enforcement: data.export vs reports.view are checked independently", () => {
    it(
      "a caller with reports.view but WITHOUT data.export can read JSON analytics but is " +
        "PERMISSION_DENIED on every CSV export — the regression test for the export path silently " +
        "reusing the read permission instead of its own",
      async () => {
        const { org, restaurant } = await seedOrgRestaurant();
        const from = dateNDaysAgo(0);
        const to = dateNDaysAgo(0);
        const viewOnlyUser = userReaching(org.id, ["reports.view"]);

        await expect(
          analyticsService.getRevenue({ restaurantId: restaurant.id, from, to }, viewOnlyUser),
        ).resolves.toBeDefined();

        await expect(
          analyticsService.exportRevenueCsv(
            { restaurantId: restaurant.id, from, to },
            viewOnlyUser,
          ),
        ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
        await expect(
          analyticsService.exportTipsCsv({ restaurantId: restaurant.id, from, to }, viewOnlyUser),
        ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
        await expect(
          analyticsService.exportStaffCsv({ restaurantId: restaurant.id, from, to }, viewOnlyUser),
        ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
        await expect(
          analyticsService.exportPerformanceCsv(
            { restaurantId: restaurant.id, from, to },
            viewOnlyUser,
          ),
        ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
        await expect(
          analyticsService.exportReportCsv(
            { restaurantId: restaurant.id, from, to, type: "period-summary" },
            viewOnlyUser,
          ),
        ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      },
    );

    it("a caller with data.export but WITHOUT reports.view is PERMISSION_DENIED on the JSON routes", async () => {
      const { org, restaurant } = await seedOrgRestaurant();
      const from = dateNDaysAgo(0);
      const to = dateNDaysAgo(0);
      const exportOnlyUser = userReaching(org.id, ["data.export"]);

      await expect(
        analyticsService.getRevenue({ restaurantId: restaurant.id, from, to }, exportOnlyUser),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      await expect(
        analyticsService.exportRevenueCsv(
          { restaurantId: restaurant.id, from, to },
          exportOnlyUser,
        ),
      ).resolves.toBeDefined();
    });

    it("throws RESTAURANT_NOT_FOUND for a caller from an unrelated Organization — never leaks existence", async () => {
      const { restaurant } = await seedOrgRestaurant();
      const { org: strangerOrg } = await seedOrgRestaurant();
      const from = dateNDaysAgo(0);
      const to = dateNDaysAgo(0);
      await expect(
        analyticsService.getRevenue(
          { restaurantId: restaurant.id, from, to },
          userReaching(strangerOrg.id),
        ),
      ).rejects.toMatchObject({ code: "RESTAURANT_NOT_FOUND" });
    });
  });
});

describe("analytics-query.schema (pure validation, no database)", () => {
  const restaurantId = randomUUID();

  it("rejects from > to", () => {
    const result = analyticsQuerySchema.safeParse({
      restaurantId,
      from: "2026-02-10",
      to: "2026-02-09",
    });
    expect(result.success).toBe(false);
  });

  it("accepts exactly a 366-day range and rejects 367 days", () => {
    const within = analyticsQuerySchema.safeParse({
      restaurantId,
      from: "2026-01-01",
      to: "2027-01-01", // 365 days apart -> 366 calendar days inclusive
    });
    expect(within.success).toBe(true);

    const tooWide = analyticsQuerySchema.safeParse({
      restaurantId,
      from: "2026-01-01",
      to: "2027-01-02", // 366 days apart -> 367 calendar days inclusive
    });
    expect(tooWide.success).toBe(false);
  });

  it("staffAnalyticsQuerySchema defaults page=1 and limit=20 when omitted", () => {
    const result = staffAnalyticsQuerySchema.parse({
      restaurantId,
      from: "2026-02-01",
      to: "2026-02-01",
    });
    expect(result.page).toBe(1);
    expect(result.limit).toBe(20);
  });

  it('reportsQuerySchema defaults type to "period-summary" when omitted', () => {
    const result = reportsQuerySchema.parse({
      restaurantId,
      from: "2026-02-01",
      to: "2026-02-01",
    });
    expect(result.type).toBe("period-summary");
  });
});
