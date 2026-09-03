import { randomUUID } from "node:crypto";
import { shiftServiceForTests } from "../../test/fixtures/shift-for-tests";
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

/** An RFC 4180-aware split, used by the escaping test. The naive `split(",")` the other
 * assertions use is correct only for files whose fields cannot contain a comma — which is every
 * file here except the one carrying a human-typed display name, and that is the whole point of
 * that test. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      out.push(field);
      field = "";
    } else field += c;
  }
  out.push(field);
  return out;
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
    const ledger = new LedgerService(prisma, shiftServiceForTests(prisma));
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
    analyticsService = new AnalyticsService(prisma, shiftServiceForTests(prisma));
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

  /**
   * ADR-065 migration: give a back-dated Transaction its own closed Shift, dated to the same day.
   *
   * `backdateLedgerLines` moves `createdAt` and deliberately does not touch `shiftId` — the two
   * labels are independent (ADR-064), which is exactly what makes that helper useless on its own
   * for a shift-scoped screen. A past day in this system is a past SHIFT, so the fixture has to
   * build one.
   */
  async function backdateToOwnShift(
    restaurantId: string,
    transactionId: string,
    daysAgo: number,
  ): Promise<string> {
    await backdateLedgerLines(transactionId, daysAgo);
    const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    // The business date is the venue's LOCAL calendar date, not the UTC one (ADR-064).
    //
    // This helper computed it in UTC when it was written, and that was wrong in a way that only
    // shows itself between local midnight and UTC midnight — a three-hour window in
    // Europe/Vilnius. Inside it, `getLocalDayWindow(tz, 0).date` says the 4th while
    // `Date.UTC(...)` says the 3rd, so a shift built here fell outside the very range the test
    // was asking for. Caught by a full-suite run at 00:32 local; it had passed every earlier run.
    // Same UTC-versus-local confusion as the shift-reporting fixture, in a second place.
    const [y, m, d] = getLocalDayWindow(TIMEZONE, 0, when).date.split("-").map(Number);
    const businessDate = new Date(Date.UTC(y, m - 1, d));
    const shift = await prisma.shift.create({
      data: {
        restaurantId,
        openedAt: when,
        closedAt: new Date(when.getTime() + 6 * 60 * 60 * 1000),
        closeReason: "BUTTON",
        businessDate,
      },
    });
    await prisma.ledgerLine.updateMany({
      where: { journalEntry: { transactionId } },
      data: { shiftId: shift.id },
    });
    return shift.id;
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
        // ADR-065: the analytics SCREEN buckets by shift, so a past day must be a past shift.
        // The property this test protects is unchanged — three captures, three buckets, in order,
        // not merged and not shifted to the wrong one.
        const { transaction: twoDaysAgoTx } = await capture(restaurant.id, 330n, 30n, waiter.id);
        await backdateToOwnShift(restaurant.id, twoDaysAgoTx.id, 2);
        const { transaction: oneDayAgoTx } = await capture(restaurant.id, 770n, 70n, waiter.id);
        await backdateToOwnShift(restaurant.id, oneDayAgoTx.id, 1);
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

  /**
   * ADR-067 — accounting's SECOND list, by shift, alongside the calendar one that stays.
   *
   * **Fixed absolute instants, never "N days ago".** Every fixture below pins real UTC timestamps
   * and a literal business date. A relative fixture has now cost this project twice — most
   * recently `backdateToOwnShift` computing a business date in UTC while the query range was
   * built in Europe/Vilnius, a disagreement that only appears between local midnight and UTC
   * midnight and therefore passes on most runs. Fixed dates cannot drift with the clock.
   *
   * Europe/Vilnius is UTC+3 in June, so local midnight ending 2026-06-15 is 2026-06-15T21:00:00Z.
   * Everything here is placed relative to that one boundary.
   */
  describe("Accounting exports: by shift, alongside by calendar day (ADR-067)", () => {
    const BUSINESS_DATE = "2026-06-15";
    const SHIFT_OPENED = new Date("2026-06-15T15:00:00.000Z"); // 18:00 local, the 15th
    const BEFORE_MIDNIGHT = new Date("2026-06-15T17:00:00.000Z"); // 20:00 local, the 15th
    const AFTER_MIDNIGHT = new Date("2026-06-15T22:30:00.000Z"); // 01:30 local, the 16th
    const SHIFT_CLOSED = new Date("2026-06-15T23:00:00.000Z"); // 02:00 local, the 16th

    /** Places every LedgerLine of a Transaction at a chosen instant and a chosen Shift (or none).
     * Both labels are set explicitly because they are independent (ADR-064) — deriving one from
     * the other in a fixture would assume exactly the property under test. */
    async function placeLines(
      transactionId: string,
      createdAt: Date,
      shiftId: string | null,
    ): Promise<void> {
      await prisma.ledgerLine.updateMany({
        where: { journalEntry: { transactionId } },
        data: { createdAt, shiftId },
      });
    }

    async function openShiftCrossingMidnight(restaurantId: string): Promise<string> {
      const shift = await prisma.shift.create({
        data: {
          restaurantId,
          openedAt: SHIFT_OPENED,
          closedAt: SHIFT_CLOSED,
          closeReason: "BUTTON",
          businessDate: new Date(`${BUSINESS_DATE}T00:00:00.000Z`),
        },
      });
      return shift.id;
    }

    function parseCsv(csv: string): { header: string[]; rows: string[][] } {
      const [head, ...rest] = csv.split("\n");
      return { header: head.split(","), rows: rest.map((r) => r.split(",")) };
    }

    it(
      "THE FALSIFICATION: a shift crossing midnight gives the by-shift and by-calendar-day " +
        "exports DIFFERENT numbers — an implementation where they coincide fails here, because " +
        "coincidence would prove the second cut never happened",
      async () => {
        const { org, restaurant } = await seedOrgRestaurant();
        const { membership: waiter } = await seedMembership(org.id, restaurant.id, "Waiter");
        const shiftId = await openShiftCrossingMidnight(restaurant.id);

        // 20:00 local on the 15th: same shift, same calendar day. Bill 900, tip 100.
        const { transaction: early } = await capture(restaurant.id, 1000n, 100n, waiter.id);
        await placeLines(early.id, BEFORE_MIDNIGHT, shiftId);
        // 01:30 local on the 16th: SAME shift, DIFFERENT calendar day. Bill 450, tip 50.
        const { transaction: late } = await capture(restaurant.id, 500n, 50n, waiter.id);
        await placeLines(late.id, AFTER_MIDNIGHT, shiftId);

        const query = { restaurantId: restaurant.id, from: BUSINESS_DATE, to: BUSINESS_DATE };
        const user = userReaching(org.id);

        const byShift = parseCsv(await analyticsService.exportRevenueByShiftCsv(query, user));
        const byCalendar = parseCsv(await analyticsService.exportRevenueCsv(query, user));

        // The shift owns its whole working day: both bills, 900 + 450.
        const shiftRow = byShift.rows.find((r) => r[0] === "shift");
        expect(shiftRow?.[5]).toBe("1350");
        // The calendar day ends at 21:00Z and cannot see the 22:30Z bill: 900 only.
        expect(byCalendar.rows[0][1]).toBe("900");

        // Stated as the inequality the task asked for, not only as two constants: an
        // implementation that quietly bucketed both files by the same cut would satisfy neither
        // number above, and would satisfy this line least of all.
        expect(shiftRow?.[5]).not.toBe(byCalendar.rows[0][1]);
      },
    );

    it(
      "every by-shift row names WHICH day it means — the business date it is called, and the " +
        "real calendar instants it spanned, so the split is visible in the file itself",
      async () => {
        const { org, restaurant } = await seedOrgRestaurant();
        const { membership: waiter } = await seedMembership(org.id, restaurant.id, "Waiter");
        const shiftId = await openShiftCrossingMidnight(restaurant.id);
        const { transaction } = await capture(restaurant.id, 1000n, 100n, waiter.id);
        await placeLines(transaction.id, AFTER_MIDNIGHT, shiftId);

        const csv = await analyticsService.exportRevenueByShiftCsv(
          { restaurantId: restaurant.id, from: BUSINESS_DATE, to: BUSINESS_DATE },
          userReaching(org.id),
        );
        const { header, rows } = parseCsv(csv);
        expect(header).toEqual([
          "scope",
          "businessDate",
          "shiftId",
          "openedAt",
          "closedAt",
          "amount",
        ]);

        const shiftRow = rows.find((r) => r[0] === "shift");
        // The day it is CALLED...
        expect(shiftRow?.[1]).toBe(BUSINESS_DATE);
        expect(shiftRow?.[2]).toBe(shiftId);
        // ...and the calendar instants it ACTUALLY spanned, which end on the following date. A
        // file carrying only the business date could not be reconciled against a bank statement.
        // ...and the calendar instants it ACTUALLY spanned, in the VENUE's own local time with
        // its offset. This assertion is the reason the export does not render UTC: in UTC the
        // closing instant is 2026-06-15T23:00:00Z, whose date reads "the 15th", and the line
        // below — the one that matters — passed by accident while showing the accountant nothing.
        expect(shiftRow?.[3]).toBe("2026-06-15T18:00:00+03:00");
        expect(shiftRow?.[4]).toBe("2026-06-16T02:00:00+03:00");
        // The working day is CALLED the 15th and ENDED on the 16th. A file that cannot show both
        // cannot be reconciled against anything.
        expect(shiftRow?.[4].slice(0, 10)).not.toBe(BUSINESS_DATE);
      },
    );

    it(
      "money carrying NO shift is named in its own row rather than silently dropped — the " +
        "historical rows ADR-065 says no backfill can honestly repair",
      async () => {
        const { org, restaurant } = await seedOrgRestaurant();
        const { membership: waiter } = await seedMembership(org.id, restaurant.id, "Waiter");
        const shiftId = await openShiftCrossingMidnight(restaurant.id);

        const { transaction: onShift } = await capture(restaurant.id, 1000n, 100n, waiter.id);
        await placeLines(onShift.id, BEFORE_MIDNIGHT, shiftId);
        // Written before ADR-064 existed: a real bill, on this calendar day, with no shift label.
        const { transaction: orphan } = await capture(restaurant.id, 220n, 20n, waiter.id);
        await placeLines(orphan.id, BEFORE_MIDNIGHT, null);

        const csv = await analyticsService.exportRevenueByShiftCsv(
          { restaurantId: restaurant.id, from: BUSINESS_DATE, to: BUSINESS_DATE },
          userReaching(org.id),
        );
        const { rows } = parseCsv(csv);

        expect(rows.find((r) => r[0] === "shift")?.[5]).toBe("900");
        // 200, visible. An implementation that summed only shifts would report 900 and lose 200
        // out of a FINANCIAL export without a word — the failure this row exists to prevent.
        const unassigned = rows.find((r) => r[0] === "unassigned");
        expect(unassigned?.[5]).toBe("200");
        // It is money without a working day, so it has no business date to claim.
        expect(unassigned?.[1]).toBe("");
        expect(unassigned?.[2]).toBe("");
      },
    );

    it(
      "staff earnings differ between the two cuts for the same midnight-crossing shift — the " +
        "same falsification applied to the per-person file",
      async () => {
        const { org, restaurant } = await seedOrgRestaurant();
        const { membership: waiter } = await seedMembership(org.id, restaurant.id, "Waiter");
        const shiftId = await openShiftCrossingMidnight(restaurant.id);

        const { transaction: early } = await capture(restaurant.id, 1000n, 100n, waiter.id);
        await placeLines(early.id, BEFORE_MIDNIGHT, shiftId);
        const { transaction: late } = await capture(restaurant.id, 500n, 50n, waiter.id);
        await placeLines(late.id, AFTER_MIDNIGHT, shiftId);

        const query = { restaurantId: restaurant.id, from: BUSINESS_DATE, to: BUSINESS_DATE };
        const user = userReaching(org.id);

        const byShift = parseCsv(await analyticsService.exportStaffEarningsByShiftCsv(query, user));
        const byCalendar = parseCsv(await analyticsService.exportStaffEarningsCsv(query, user));

        // Tips column is last. The shift saw both tips; the calendar day saw only the first.
        expect(byShift.rows[0][7]).toBe("150");
        expect(byCalendar.rows[0][7]).toBe("100");
        expect(byShift.rows[0][7]).not.toBe(byCalendar.rows[0][7]);

        // And each file says which cut produced it — the first column, on every row.
        expect(byShift.rows[0][0]).toBe("shift");
        expect(byCalendar.rows[0][0]).toBe("calendar");
      },
    );

    it(
      "every staff-earnings row carries the period it covers — a file handed to a bookkeeper " +
        "has no download context to fall back on",
      async () => {
        const { org, restaurant } = await seedOrgRestaurant();
        const { membership: waiter } = await seedMembership(org.id, restaurant.id, "Waiter");
        const shiftId = await openShiftCrossingMidnight(restaurant.id);
        const { transaction } = await capture(restaurant.id, 1000n, 100n, waiter.id);
        await placeLines(transaction.id, BEFORE_MIDNIGHT, shiftId);

        const csv = await analyticsService.exportStaffEarningsCsv(
          { restaurantId: restaurant.id, from: BUSINESS_DATE, to: BUSINESS_DATE },
          userReaching(org.id),
        );
        const { header, rows } = parseCsv(csv);
        expect(header).toEqual([
          "dayBasis",
          "from",
          "to",
          "membershipId",
          "displayName",
          "email",
          "currency",
          "tips",
        ]);
        expect(rows[0][1]).toBe(BUSINESS_DATE);
        expect(rows[0][2]).toBe(BUSINESS_DATE);
        expect(rows[0][6]).toBe("EUR");
      },
    );

    it(
      "says nothing about salary, withholding or tax — asserted as an absence, because the " +
        "wording is the decision (Model B: the restaurant never receives the tip, ADR-053) and " +
        "VMI has not answered on whether a tax figure is shown or withheld",
      async () => {
        const { org, restaurant } = await seedOrgRestaurant();
        const { membership: waiter } = await seedMembership(org.id, restaurant.id, "Waiter");
        const shiftId = await openShiftCrossingMidnight(restaurant.id);
        const { transaction } = await capture(restaurant.id, 1000n, 100n, waiter.id);
        await placeLines(transaction.id, BEFORE_MIDNIGHT, shiftId);

        const query = { restaurantId: restaurant.id, from: BUSINESS_DATE, to: BUSINESS_DATE };
        const csv = await analyticsService.exportStaffEarningsCsv(query, userReaching(org.id));
        const header = csv.split("\n")[0].toLowerCase();

        // A future column called `netPay` or `taxWithheld` would describe a money movement this
        // product does not perform. This assertion is what makes adding one a deliberate act.
        for (const forbidden of ["payroll", "salary", "wage", "withhold", "tax", "net pay"]) {
          expect(header).not.toContain(forbidden);
        }
      },
    );

    it(
      "quotes a display name containing a comma, and neutralises one that a spreadsheet would " +
        "execute as a formula — the first export to carry text a human typed",
      async () => {
        const { org, restaurant } = await seedOrgRestaurant();
        const { membership: comma, user: commaUser } = await seedMembership(
          org.id,
          restaurant.id,
          "Waiter",
        );
        const { membership: formula, user: formulaUser } = await seedMembership(
          org.id,
          restaurant.id,
          "Waiter",
        );
        await prisma.user.update({
          where: { id: commaUser.id },
          data: { displayName: "O'Brien, Jr." },
        });
        await prisma.user.update({
          where: { id: formulaUser.id },
          data: { displayName: '=HYPERLINK("http://attacker.example","Total")' },
        });

        const shiftId = await openShiftCrossingMidnight(restaurant.id);
        const { transaction: a } = await capture(restaurant.id, 1000n, 200n, comma.id);
        await placeLines(a.id, BEFORE_MIDNIGHT, shiftId);
        const { transaction: b } = await capture(restaurant.id, 1000n, 100n, formula.id);
        await placeLines(b.id, BEFORE_MIDNIGHT, shiftId);

        const csv = await analyticsService.exportStaffEarningsCsv(
          { restaurantId: restaurant.id, from: BUSINESS_DATE, to: BUSINESS_DATE },
          userReaching(org.id),
        );

        // Quoted, so the comma cannot shift every following column by one. A naive join(",")
        // produces nine fields on this row instead of eight, and fails here.
        expect(csv).toContain('"O\'Brien, Jr."');
        for (const line of csv.split("\n").slice(1)) {
          expect(splitCsvLine(line)).toHaveLength(8);
        }
        // Neutralised: the cell is text a bookkeeper reads, not a formula their spreadsheet runs.
        expect(csv).toContain("'=HYPERLINK");
      },
    );

    it("the by-shift period summary names its own day basis, and the calendar one is untouched", async () => {
      const { org, restaurant } = await seedOrgRestaurant();
      const { membership: waiter } = await seedMembership(org.id, restaurant.id, "Waiter");
      const shiftId = await openShiftCrossingMidnight(restaurant.id);
      const { transaction } = await capture(restaurant.id, 1000n, 100n, waiter.id);
      await placeLines(transaction.id, AFTER_MIDNIGHT, shiftId);

      const query = { restaurantId: restaurant.id, from: BUSINESS_DATE, to: BUSINESS_DATE };
      const user = userReaching(org.id);

      const shiftCsv = await analyticsService.exportReportByShiftCsv(
        { ...query, type: "period-summary" as const },
        user,
      );
      expect(shiftCsv.split("\n")[0].split(",")[0]).toBe("dayBasis");
      expect(shiftCsv.split("\n")[1].split(",")[0]).toBe("shift");

      // The calendar export keeps the exact header it had before ADR-067 — it is correct and the
      // task's own boundary was that it must remain. A change to it fails here.
      const calendarCsv = await analyticsService.exportReportCsv(
        { ...query, type: "period-summary" as const },
        user,
      );
      expect(calendarCsv.split("\n")[0]).toBe(
        "restaurantId,from,to,type,revenue,tips,averageTipBasisPoints,transactionCount",
      );
    });

    it(
      "the new exports require data.export, not reports.view — checked independently, the same " +
        "way ADR-027 Decision 4 already requires of every other export route",
      async () => {
        const { org, restaurant } = await seedOrgRestaurant();
        const query = { restaurantId: restaurant.id, from: BUSINESS_DATE, to: BUSINESS_DATE };
        const readOnly = userReaching(org.id, ["reports.view"]);

        for (const call of [
          () => analyticsService.exportRevenueByShiftCsv(query, readOnly),
          () => analyticsService.exportTipsByShiftCsv(query, readOnly),
          () => analyticsService.exportStaffEarningsCsv(query, readOnly),
          () => analyticsService.exportStaffEarningsByShiftCsv(query, readOnly),
        ]) {
          await expect(call()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
        }

        // The discriminating half: the same caller holding data.export instead gets the files.
        const exporter = userReaching(org.id, ["data.export"]);
        await expect(analyticsService.exportRevenueByShiftCsv(query, exporter)).resolves.toContain(
          "scope,businessDate",
        );
        await expect(analyticsService.exportStaffEarningsCsv(query, exporter)).resolves.toContain(
          "dayBasis,from,to",
        );
      },
    );
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
