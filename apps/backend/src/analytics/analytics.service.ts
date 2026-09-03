import { Injectable } from "@nestjs/common";
import type { Restaurant } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { csvLine } from "../common/csv.util";
import { getReachableReportingRestaurantOrThrow } from "../common/restaurant-reachability.util";
import {
  enumerateDates,
  formatInstantInZone,
  getDayWindowForDate,
} from "../common/timezone-day.util";
import {
  BILL_REVENUE_ACCOUNTS,
  netForRestaurantWindow,
  netForRestaurantWindowWithoutShift,
  netTipsByMembershipForRestaurantWindow,
  netForRestaurantShifts,
  netTipsByMembershipForRestaurantShifts,
  countCapturesForRestaurantShifts,
} from "../ledger/restaurant-ledger-window.util";
import { ShiftService } from "../shift/shift.service";
import { PrismaService } from "../prisma/prisma.service";
import type {
  AnalyticsQueryDto,
  ReportsQueryDto,
  StaffAnalyticsQueryDto,
} from "./dto/analytics-query.schema";

export interface AnalyticsSeriesPoint {
  date: string;
  amount: string;
}

/** One line of a by-shift accounting export (ADR-067). `scope` is the first column deliberately:
 * it is the field that tells the reader whether the rest of the row describes a working day or the
 * money that belongs to no working day at all. */
export interface ShiftExportRow {
  scope: "shift" | "unassigned";
  businessDate: string;
  shiftId: string;
  openedAt: string;
  closedAt: string;
  amount: string;
}

export interface RevenueAnalytics {
  restaurantId: string;
  from: string;
  to: string;
  total: string;
  /** Same fixed caption as Dashboard's own todayRevenueNote (ADR-026) — this total is bill-only
   * sales, before the platform fee is deducted, not ADR-025's netRestaurantRevenue. */
  totalNote: string;
  series: AnalyticsSeriesPoint[];
}

export interface TipsAnalytics {
  restaurantId: string;
  from: string;
  to: string;
  total: string;
  series: AnalyticsSeriesPoint[];
}

export interface StaffAnalyticsEntry {
  membershipId: string;
  email: string;
  tips: string;
}

export interface StaffAnalyticsPage {
  restaurantId: string;
  from: string;
  to: string;
  data: StaffAnalyticsEntry[];
  meta: { page: number; limit: number; total: number; pages: number };
}

export interface PeriodTotals {
  from: string;
  to: string;
  revenue: string;
  tips: string;
  transactionCount: number;
}

export interface PerformanceAnalytics {
  restaurantId: string;
  currentPeriod: PeriodTotals;
  previousPeriod: PeriodTotals;
  /** Basis points (ADR-021's vocabulary), `null` — never "0" — when the previous period's own
   * figure is exactly 0: a percentage change has no meaningful value against a zero baseline
   * (division by zero), the same "null, not a fabricated 0" discipline as ADR-025/026. */
  changeBasisPoints: {
    revenue: string | null;
    tips: string | null;
    transactionCount: string | null;
  };
}

export interface PeriodSummaryReport {
  restaurantId: string;
  from: string;
  to: string;
  type: "period-summary";
  revenue: string;
  revenueNote: string;
  tips: string;
  averageTipBasisPoints: string | null;
  transactionCount: number;
  topStaff: StaffAnalyticsEntry[];
}

const TOTAL_NOTE = "Before platform fee deduction";
const REPORT_TOP_STAFF_LIMIT = 5;
const VIEW_PERMISSION = "reports.view";
const EXPORT_PERMISSION = "data.export";

/** IMPLEMENTATION_PLAN.md, Sprint 10 (Analytics). DoD: "Every analytics figure is reproducible
 * from LedgerLine" — same discipline as Dashboard (ADR-026): every money figure here is a live
 * SUM(CREDIT)-SUM(DEBIT) aggregation via restaurant-ledger-window.util.ts, generalized from
 * Dashboard's fixed "today"/"last 7 days" windows to an arbitrary, caller-supplied date range.
 * See ADR-027 for the Performance/Reports/Exports scope resolution this module implements.
 *
 * Every public method resolves reachability + a permission itself, with the JSON `getX` methods
 * requiring `reports.view` and the CSV `exportXCsv` methods requiring `data.export` instead (the
 * same permission Sprint 8's Transaction export already uses) — never by having exportXCsv call
 * getX internally, which would silently check the wrong permission for what the route itself
 * actually requires. The private `computeX` methods hold the pure aggregation logic, shared by
 * both the JSON and CSV path for the same resource, taking an already-resolved Restaurant. */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shifts: ShiftService,
  ) {}

  async getRevenue(query: AnalyticsQueryDto, user: AuthenticatedUser): Promise<RevenueAnalytics> {
    const restaurant = await this.reachable(query.restaurantId, user, VIEW_PERMISSION);
    return this.computeRevenueByShift(restaurant, query.from, query.to);
  }

  async exportRevenueCsv(query: AnalyticsQueryDto, user: AuthenticatedUser): Promise<string> {
    const restaurant = await this.reachable(query.restaurantId, user, EXPORT_PERMISSION);
    const data = await this.computeRevenueByCalendarDay(restaurant, query.from, query.to);
    const header = "date,amount";
    const lines = data.series.map((p) => `${p.date},${p.amount}`);
    return [header, ...lines].join("\n");
  }

  async getTips(query: AnalyticsQueryDto, user: AuthenticatedUser): Promise<TipsAnalytics> {
    const restaurant = await this.reachable(query.restaurantId, user, VIEW_PERMISSION);
    return this.computeTipsByShift(restaurant, query.from, query.to);
  }

  async exportTipsCsv(query: AnalyticsQueryDto, user: AuthenticatedUser): Promise<string> {
    const restaurant = await this.reachable(query.restaurantId, user, EXPORT_PERMISSION);
    const data = await this.computeTipsByCalendarDay(restaurant, query.from, query.to);
    const header = "date,amount";
    const lines = data.series.map((p) => `${p.date},${p.amount}`);
    return [header, ...lines].join("\n");
  }

  /**
   * ACCOUNTING's OTHER list: Revenue by shift (ADR-065 §3, ADR-067).
   *
   * **A separate route, not a flag on the calendar one.** A boolean in a query string makes the
   * call site ambiguous — the reader of `?byShift=true` has to know what the false branch does to
   * know what the true one means — and the two files answer different questions to different
   * readers. Two names that say what they are beat one name plus a parameter.
   */
  async exportRevenueByShiftCsv(
    query: AnalyticsQueryDto,
    user: AuthenticatedUser,
  ): Promise<string> {
    const restaurant = await this.reachable(query.restaurantId, user, EXPORT_PERMISSION);
    const rows = await this.buildShiftExportRows(
      restaurant,
      query.from,
      query.to,
      BILL_REVENUE_ACCOUNTS,
    );
    return renderShiftExport(rows);
  }

  /** Tips by shift — `exportRevenueByShiftCsv`'s definition over `TIP_PAYABLE`. */
  async exportTipsByShiftCsv(query: AnalyticsQueryDto, user: AuthenticatedUser): Promise<string> {
    const restaurant = await this.reachable(query.restaurantId, user, EXPORT_PERMISSION);
    const rows = await this.buildShiftExportRows(restaurant, query.from, query.to, ["TIP_PAYABLE"]);
    return renderShiftExport(rows);
  }

  /**
   * **Staff earnings for a period, for accounting (ADR-067).** Who received how much in tips, by
   * Membership, over a date range, in a form that can be handed to a bookkeeper as-is.
   *
   * **What this is NOT, deliberately and by name.** It is not payroll. In Model B — the single
   * target (ADR-053) — the restaurant never receives the tip and therefore cannot pay it out; a
   * file called "payroll" would describe a money movement that does not happen in this product.
   * There is no salary column, no withholding column, and no tax figure, because whether a tax
   * figure is displayed or withheld is not known: VMI has not answered. A column added later is a
   * change; a column that means the wrong thing today is a liability.
   *
   * The difference from `/analytics/staff/export` is form, not data: that file is three columns of
   * identifiers, and out of its download context it does not say what period it covers or on whose
   * day it is counted. Every row here carries both.
   */
  async exportStaffEarningsCsv(query: AnalyticsQueryDto, user: AuthenticatedUser): Promise<string> {
    const restaurant = await this.reachable(query.restaurantId, user, EXPORT_PERMISSION);
    const ranked = await this.rankedStaffForRange(restaurant, query.from, query.to);
    return this.renderStaffEarnings(restaurant, query.from, query.to, "calendar", ranked);
  }

  /** `exportStaffEarningsCsv` counted on the venue's working day instead of the calendar one. */
  async exportStaffEarningsByShiftCsv(
    query: AnalyticsQueryDto,
    user: AuthenticatedUser,
  ): Promise<string> {
    const restaurant = await this.reachable(query.restaurantId, user, EXPORT_PERMISSION);
    const shiftIds = await this.shiftIdsForRange(restaurant.id, query.from, query.to);
    const ranked = await this.rankStaffByShifts(restaurant.id, shiftIds);
    return this.renderStaffEarnings(restaurant, query.from, query.to, "shift", ranked);
  }

  /** The period summary counted by shift — `computeReport`, which the JSON route already uses,
   * rendered as the CSV its calendar twin already had. */
  async exportReportByShiftCsv(query: ReportsQueryDto, user: AuthenticatedUser): Promise<string> {
    const restaurant = await this.reachable(query.restaurantId, user, EXPORT_PERMISSION);
    const report = await this.computeReport(restaurant, query.from, query.to);
    const header =
      "dayBasis,restaurantId,from,to,type,revenue,tips,averageTipBasisPoints,transactionCount";
    const row = csvLine([
      "shift",
      report.restaurantId,
      report.from,
      report.to,
      report.type,
      report.revenue,
      report.tips,
      report.averageTipBasisPoints ?? "",
      report.transactionCount,
    ]);
    return [header, row].join("\n");
  }

  /** Full list, ranked by net tips over the period — not capped to a top N the way Dashboard's
   * Top Staff is (ADR-026); paginated instead, same page/limit convention as Transaction List. */
  async getStaff(
    query: StaffAnalyticsQueryDto,
    user: AuthenticatedUser,
  ): Promise<StaffAnalyticsPage> {
    const restaurant = await this.reachable(query.restaurantId, user, VIEW_PERMISSION);
    const ranked = await this.rankedStaffForRange(restaurant, query.from, query.to);

    const total = ranked.length;
    const offset = (query.page - 1) * query.limit;
    const pageEntries = ranked.slice(offset, offset + query.limit);
    const data = await this.attachEmails(pageEntries);

    return {
      restaurantId: restaurant.id,
      from: query.from,
      to: query.to,
      data,
      meta: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) },
    };
  }

  /** Every matching row, not paginated — same "export ignores pagination" precedent as
   * GET /transactions/export. */
  async exportStaffCsv(query: AnalyticsQueryDto, user: AuthenticatedUser): Promise<string> {
    const restaurant = await this.reachable(query.restaurantId, user, EXPORT_PERMISSION);
    const ranked = await this.rankedStaffForRange(restaurant, query.from, query.to);
    const data = await this.attachEmails(ranked);

    const header = "membershipId,email,tips";
    const lines = data.map((e) => `${e.membershipId},${e.email},${e.tips}`);
    return [header, ...lines].join("\n");
  }

  /** Current period vs the immediately preceding period of the SAME length (e.g. 1-31 July vs
   * 1-30 June for a 31-day range) — the standard, unambiguous "vs previous period" definition,
   * UX_MAP.md's "Growth" concept made concrete (ADR-027). */
  async getPerformance(
    query: AnalyticsQueryDto,
    user: AuthenticatedUser,
  ): Promise<PerformanceAnalytics> {
    const restaurant = await this.reachable(query.restaurantId, user, VIEW_PERMISSION);
    return this.computePerformance(restaurant, query.from, query.to);
  }

  async exportPerformanceCsv(query: AnalyticsQueryDto, user: AuthenticatedUser): Promise<string> {
    const restaurant = await this.reachable(query.restaurantId, user, EXPORT_PERMISSION);
    const perf = await this.computePerformance(restaurant, query.from, query.to);
    const header = "metric,currentPeriod,previousPeriod,changeBasisPoints";
    const rows = [
      csvRow(
        "revenue",
        perf.currentPeriod.revenue,
        perf.previousPeriod.revenue,
        perf.changeBasisPoints.revenue,
      ),
      csvRow(
        "tips",
        perf.currentPeriod.tips,
        perf.previousPeriod.tips,
        perf.changeBasisPoints.tips,
      ),
      csvRow(
        "transactionCount",
        perf.currentPeriod.transactionCount,
        perf.previousPeriod.transactionCount,
        perf.changeBasisPoints.transactionCount,
      ),
    ];
    return [header, ...rows].join("\n");
  }

  /** The one named report Sprint 10 ships (ADR-027): a period summary bundling Revenue, Tips,
   * Average Tip, transaction count, and Top Staff — everything a Reports screen's own first real
   * use case needs in one round trip, not a report-builder. `type` is already a real, extensible
   * union (analytics-query.schema.ts) with exactly one member; a second report type is a second
   * enum value and a second branch here, not a redesign — same precedent as TipAllocationStrategy
   * (ADR-007), PlatformFeePolicy (ADR-021), and the Outbox's no-handler-registry call (ADR-024). */
  async getReport(query: ReportsQueryDto, user: AuthenticatedUser): Promise<PeriodSummaryReport> {
    const restaurant = await this.reachable(query.restaurantId, user, VIEW_PERMISSION);
    return this.computeReport(restaurant, query.from, query.to);
  }

  /** Flat scalar fields only, same as Revenue/Tips/Staff CSVs — topStaff is available via its own
   * /staff/export, not duplicated into a second CSV section here (Transaction export's own
   * precedent: nested lists get their own export, never an awkward multi-section CSV). */
  async exportReportCsv(query: ReportsQueryDto, user: AuthenticatedUser): Promise<string> {
    const restaurant = await this.reachable(query.restaurantId, user, EXPORT_PERMISSION);
    const report = await this.computeReportByCalendarDay(restaurant, query.from, query.to);
    const header = "restaurantId,from,to,type,revenue,tips,averageTipBasisPoints,transactionCount";
    const row = [
      report.restaurantId,
      report.from,
      report.to,
      report.type,
      report.revenue,
      report.tips,
      report.averageTipBasisPoints ?? "",
      report.transactionCount.toString(),
    ].join(",");
    return [header, row].join("\n");
  }

  private async reachable(
    restaurantId: string,
    user: AuthenticatedUser,
    permission: string,
  ): Promise<Restaurant> {
    return getReachableReportingRestaurantOrThrow(this.prisma, restaurantId, user, permission);
  }

  private async computeRevenueByShift(
    restaurant: Restaurant,
    from: string,
    to: string,
  ): Promise<RevenueAnalytics> {
    const series = await this.buildShiftSeries(restaurant, from, to, BILL_REVENUE_ACCOUNTS);
    const total = series.reduce((acc, p) => acc + BigInt(p.amount), 0n);
    return {
      restaurantId: restaurant.id,
      from,
      to,
      total: total.toString(),
      totalNote: TOTAL_NOTE,
      series,
    };
  }

  private async computeRevenueByCalendarDay(
    restaurant: Restaurant,
    from: string,
    to: string,
  ): Promise<RevenueAnalytics> {
    const series = await this.buildSeries(restaurant, from, to, BILL_REVENUE_ACCOUNTS);
    const total = series.reduce((acc, p) => acc + BigInt(p.amount), 0n);
    return {
      restaurantId: restaurant.id,
      from,
      to,
      total: total.toString(),
      totalNote: TOTAL_NOTE,
      series,
    };
  }

  private async computeTipsByShift(
    restaurant: Restaurant,
    from: string,
    to: string,
  ): Promise<TipsAnalytics> {
    const series = await this.buildShiftSeries(restaurant, from, to, ["TIP_PAYABLE"]);
    const total = series.reduce((acc, p) => acc + BigInt(p.amount), 0n);
    return { restaurantId: restaurant.id, from, to, total: total.toString(), series };
  }

  private async computeTipsByCalendarDay(
    restaurant: Restaurant,
    from: string,
    to: string,
  ): Promise<TipsAnalytics> {
    const series = await this.buildSeries(restaurant, from, to, ["TIP_PAYABLE"]);
    const total = series.reduce((acc, p) => acc + BigInt(p.amount), 0n);
    return { restaurantId: restaurant.id, from, to, total: total.toString(), series };
  }

  private async computePerformance(
    restaurant: Restaurant,
    from: string,
    to: string,
  ): Promise<PerformanceAnalytics> {
    const rangeDays = enumerateDates(from, to).length;
    const previousTo = shiftDate(from, -1);
    const previousFrom = shiftDate(previousTo, -(rangeDays - 1));

    const [currentPeriod, previousPeriod] = await Promise.all([
      this.periodTotals(restaurant, from, to),
      this.periodTotals(restaurant, previousFrom, previousTo),
    ]);

    return {
      restaurantId: restaurant.id,
      currentPeriod,
      previousPeriod,
      changeBasisPoints: {
        revenue: changeBasisPoints(BigInt(currentPeriod.revenue), BigInt(previousPeriod.revenue)),
        tips: changeBasisPoints(BigInt(currentPeriod.tips), BigInt(previousPeriod.tips)),
        transactionCount: changeBasisPoints(
          BigInt(currentPeriod.transactionCount),
          BigInt(previousPeriod.transactionCount),
        ),
      },
    };
  }

  private async computeReport(
    restaurant: Restaurant,
    from: string,
    to: string,
  ): Promise<PeriodSummaryReport> {
    // ADR-065: the report screen counts SHIFTS. Its CSV twin stays calendar — see exportReportCsv.
    const shiftIds = await this.shiftIdsForRange(restaurant.id, from, to);

    const [revenue, tips, transactionCount, ranked] = await Promise.all([
      netForRestaurantShifts(this.prisma, restaurant.id, BILL_REVENUE_ACCOUNTS, shiftIds),
      netForRestaurantShifts(this.prisma, restaurant.id, ["TIP_PAYABLE"], shiftIds),
      countCapturesForRestaurantShifts(this.prisma, restaurant.id, shiftIds),
      this.rankStaffByShifts(restaurant.id, shiftIds),
    ]);
    const topStaff = await this.attachEmails(ranked.slice(0, REPORT_TOP_STAFF_LIMIT));

    return {
      restaurantId: restaurant.id,
      from,
      to,
      type: "period-summary",
      revenue: revenue.toString(),
      revenueNote: TOTAL_NOTE,
      tips: tips.toString(),
      averageTipBasisPoints: changeRatioBasisPoints(tips, revenue),
      transactionCount,
      topStaff,
    };
  }

  private async computeReportByCalendarDay(
    restaurant: Restaurant,
    from: string,
    to: string,
  ): Promise<PeriodSummaryReport> {
    // ACCOUNTING's twin (ADR-065): calendar days, because the accountant is bound by law to a
    // calendar period. Deliberately NOT switched to shifts, and its own test asserts that.
    const start = getDayWindowForDate(restaurant.timezone, from).start;
    const end = getDayWindowForDate(restaurant.timezone, to).end;

    const [revenue, tips, transactionCount, ranked] = await Promise.all([
      netForRestaurantWindow(this.prisma, restaurant.id, BILL_REVENUE_ACCOUNTS, start, end),
      netForRestaurantWindow(this.prisma, restaurant.id, ["TIP_PAYABLE"], start, end),
      this.prisma.transaction.count({
        where: { restaurantId: restaurant.id, createdAt: { gte: start, lt: end } },
      }),
      this.rankStaffByTips(restaurant.id, start, end),
    ]);
    const topStaff = await this.attachEmails(ranked.slice(0, REPORT_TOP_STAFF_LIMIT));

    return {
      restaurantId: restaurant.id,
      from,
      to,
      type: "period-summary",
      revenue: revenue.toString(),
      revenueNote: TOTAL_NOTE,
      tips: tips.toString(),
      averageTipBasisPoints: changeRatioBasisPoints(tips, revenue),
      transactionCount,
      topStaff,
    };
  }

  /**
   * The SCREEN's series: one point per SHIFT whose business date falls in the range (ADR-065).
   *
   * **Deliberately a second method rather than a flag on `buildSeries`.** The JSON screens and
   * the CSV exports now answer two different questions about the same money — the venue's working
   * days and the state's calendar days — and a boolean would let a call site be ambiguous about
   * which it meant. Two names, each unambiguous where it is called. `buildSeries` below is
   * unchanged and stays calendar: it is what the accounting exports use.
   *
   * A shift opened on the 7th and closed at 02:00 on the 8th appears once, on the 7th, with its
   * after-midnight takings included — which is the whole point.
   */
  private async buildShiftSeries(
    restaurant: { id: string; timezone: string },
    from: string,
    to: string,
    accounts: Parameters<typeof netForRestaurantWindow>[2],
  ): Promise<AnalyticsSeriesPoint[]> {
    const shifts = await this.shifts.shiftsForBusinessDateRange(restaurant.id, from, to);
    return Promise.all(
      shifts.map(async (shift) => {
        const amount = await netForRestaurantShifts(this.prisma, restaurant.id, accounts, [
          shift.id,
        ]);
        return { date: shift.businessDate.toISOString().slice(0, 10), amount: amount.toString() };
      }),
    );
  }

  /**
   * The by-shift export's rows: one per Shift, plus one naming the money the shift cut cannot see.
   *
   * **Every row states which day it means, and a shift row states it twice** — `businessDate` is
   * the day the venue CALLS this working day, `openedAt`/`closedAt` are the real calendar instants
   * it actually spanned. That pair is the split ADR-065 requires to be legible: a shift of the 2nd
   * that closed at 01:30 on the 3rd shows both facts on one line, and an accountant reconciling a
   * Z-report against a calendar month can see exactly where the two cuts diverge.
   *
   * **The trailing `unassigned` row is not decoration.** Lines written before ADR-064 carry no
   * `shiftId` and no honest backfill exists, so a by-shift export over a historical period omits
   * real money. Omitting money from a financial file without saying so is the failure mode here;
   * naming it costs one query.
   */
  private async buildShiftExportRows(
    restaurant: Restaurant,
    from: string,
    to: string,
    accounts: Parameters<typeof netForRestaurantWindow>[2],
  ): Promise<ShiftExportRow[]> {
    const shifts = await this.shifts.shiftsForBusinessDateRange(restaurant.id, from, to);
    const shiftRows = await Promise.all(
      shifts.map(async (shift) => {
        const amount = await netForRestaurantShifts(this.prisma, restaurant.id, accounts, [
          shift.id,
        ]);
        return {
          scope: "shift" as const,
          businessDate: shift.businessDate.toISOString().slice(0, 10),
          shiftId: shift.id,
          // The VENUE's local time, with offset — not UTC. A shift of the 15th closing at 02:00
          // local on the 16th is 23:00Z on the 15th, whose date reads "the 15th": rendered in UTC
          // the file agrees with the calendar cut at exactly the boundary where the two are meant
          // to differ, and shows the accountant nothing to reconcile. Caught by a test, not by
          // review — the first version of this code emitted `toISOString()` (ADR-067).
          openedAt: formatInstantInZone(restaurant.timezone, shift.openedAt),
          closedAt: shift.closedAt ? formatInstantInZone(restaurant.timezone, shift.closedAt) : "",
          amount: amount.toString(),
        };
      }),
    );

    const unassigned = await netForRestaurantWindowWithoutShift(
      this.prisma,
      restaurant.id,
      accounts,
      getDayWindowForDate(restaurant.timezone, from).start,
      getDayWindowForDate(restaurant.timezone, to).end,
    );

    return [
      ...shiftRows,
      {
        scope: "unassigned" as const,
        businessDate: "",
        shiftId: "",
        openedAt: "",
        closedAt: "",
        amount: unassigned.toString(),
      },
    ];
  }

  /** Both staff-earnings exports differ only in how `ranked` was counted, so the file they produce
   * is built once — and `dayBasis` is what tells the reader which of the two they are holding. */
  private async renderStaffEarnings(
    restaurant: Restaurant,
    from: string,
    to: string,
    dayBasis: "calendar" | "shift",
    ranked: Array<[string, bigint]>,
  ): Promise<string> {
    const header = "dayBasis,from,to,membershipId,displayName,email,currency,tips";
    const people = await this.identifyMemberships(ranked);
    const lines = people.map((p) =>
      csvLine([
        dayBasis,
        from,
        to,
        p.membershipId,
        p.displayName,
        p.email,
        restaurant.currency,
        p.tips,
      ]),
    );
    return [header, ...lines].join("\n");
  }

  /** `attachEmails` plus the person's name. `User.displayName` did not exist when Dashboard's Top
   * Staff was built (ADR-026 recorded the absence as a limitation); it does now, and a file for a
   * human reader should carry a human name rather than an email address. */
  private async identifyMemberships(
    ranked: Array<[string, bigint]>,
  ): Promise<Array<{ membershipId: string; displayName: string; email: string; tips: string }>> {
    if (ranked.length === 0) return [];
    const memberships = await this.prisma.membership.findMany({
      where: { id: { in: ranked.map(([id]) => id) } },
      include: { user: { select: { email: true, displayName: true } } },
    });
    const byId = new Map(memberships.map((m) => [m.id, m.user]));
    return ranked.map(([membershipId, tips]) => ({
      membershipId,
      displayName: byId.get(membershipId)?.displayName ?? "",
      email: byId.get(membershipId)?.email ?? "",
      tips: tips.toString(),
    }));
  }

  /** Every Shift id in the range — the scope every shift-based total below is computed over. */
  private async shiftIdsForRange(
    restaurantId: string,
    from: string,
    to: string,
  ): Promise<string[]> {
    const shifts = await this.shifts.shiftsForBusinessDateRange(restaurantId, from, to);
    return shifts.map((shift) => shift.id);
  }

  /** ACCOUNTING's series: one point per calendar day. Unchanged, and it must stay that way —
   * ADR-065 keeps the exports calendar-scoped because the accountant is bound by law to a
   * calendar period. Its own test asserts this, and fails if it is switched to shifts. */
  private async buildSeries(
    restaurant: { id: string; timezone: string },
    from: string,
    to: string,
    accounts: Parameters<typeof netForRestaurantWindow>[2],
  ): Promise<AnalyticsSeriesPoint[]> {
    const dates = enumerateDates(from, to);
    return Promise.all(
      dates.map(async (date) => {
        const window = getDayWindowForDate(restaurant.timezone, date);
        const amount = await netForRestaurantWindow(
          this.prisma,
          restaurant.id,
          accounts,
          window.start,
          window.end,
        );
        return { date, amount: amount.toString() };
      }),
    );
  }

  /** `rankStaffByTips`'s definition, scoped by shift (ADR-065). */
  private async rankStaffByShifts(
    restaurantId: string,
    shiftIds: string[],
  ): Promise<Array<[string, bigint]>> {
    const netByMembership = await netTipsByMembershipForRestaurantShifts(
      this.prisma,
      restaurantId,
      shiftIds,
    );
    return [...netByMembership.entries()].sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));
  }

  private async rankedStaffForRange(
    restaurant: { id: string; timezone: string },
    from: string,
    to: string,
  ): Promise<Array<[string, bigint]>> {
    const start = getDayWindowForDate(restaurant.timezone, from).start;
    const end = getDayWindowForDate(restaurant.timezone, to).end;
    return this.rankStaffByTips(restaurant.id, start, end);
  }

  private async rankStaffByTips(
    restaurantId: string,
    start: Date,
    end: Date,
  ): Promise<Array<[string, bigint]>> {
    const netByMembership = await netTipsByMembershipForRestaurantWindow(
      this.prisma,
      restaurantId,
      start,
      end,
    );
    return [...netByMembership.entries()].sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));
  }

  private async attachEmails(ranked: Array<[string, bigint]>): Promise<StaffAnalyticsEntry[]> {
    if (ranked.length === 0) return [];
    const memberships = await this.prisma.membership.findMany({
      where: { id: { in: ranked.map(([id]) => id) } },
      include: { user: { select: { email: true } } },
    });
    const emailByMembership = new Map(memberships.map((m) => [m.id, m.user.email]));
    return ranked.map(([membershipId, tips]) => ({
      membershipId,
      email: emailByMembership.get(membershipId) ?? "",
      tips: tips.toString(),
    }));
  }

  private async periodTotals(
    restaurant: { id: string; timezone: string },
    from: string,
    to: string,
  ): Promise<PeriodTotals> {
    const start = getDayWindowForDate(restaurant.timezone, from).start;
    const end = getDayWindowForDate(restaurant.timezone, to).end;
    const [revenue, tips, transactionCount] = await Promise.all([
      netForRestaurantWindow(this.prisma, restaurant.id, BILL_REVENUE_ACCOUNTS, start, end),
      netForRestaurantWindow(this.prisma, restaurant.id, ["TIP_PAYABLE"], start, end),
      this.prisma.transaction.count({
        where: { restaurantId: restaurant.id, createdAt: { gte: start, lt: end } },
      }),
    ]);
    return { from, to, revenue: revenue.toString(), tips: tips.toString(), transactionCount };
  }
}

/** The by-shift export file. Shared by Revenue and Tips: the two differ only in which accounts
 * were summed, never in what a row means. */
function renderShiftExport(rows: ShiftExportRow[]): string {
  const header = "scope,businessDate,shiftId,openedAt,closedAt,amount";
  const lines = rows.map((r) =>
    csvLine([r.scope, r.businessDate, r.shiftId, r.openedAt, r.closedAt, r.amount]),
  );
  return [header, ...lines].join("\n");
}

/** Pure calendar-date arithmetic — no timezone involved (same reasoning as timezone-day.util.ts's
 * own addCalendarDays). `n` may be negative. */
function shiftDate(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + n));
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Percentage change from `previous` to `current`, in basis points — `null`, never a fabricated
 * 0 or an Infinity, when `previous` is exactly 0 (no meaningful baseline to compare against). */
function changeBasisPoints(current: bigint, previous: bigint): string | null {
  if (previous === 0n) return null;
  return (((current - previous) * 10_000n) / previous).toString();
}

/** Ratio of two sums as basis points (ADR-026's own averageTipBasisPoints formula) — `null` when
 * the denominator is exactly 0, same discipline as changeBasisPoints above. */
function changeRatioBasisPoints(numerator: bigint, denominator: bigint): string | null {
  if (denominator === 0n) return null;
  return ((numerator * 10_000n) / denominator).toString();
}

function csvRow(
  metric: string,
  current: string | number,
  previous: string | number,
  changeBasisPointsValue: string | null,
): string {
  return `${metric},${current},${previous},${changeBasisPointsValue ?? ""}`;
}
