import { Injectable } from "@nestjs/common";
import type { Restaurant, Transaction } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { getReachableReportingRestaurantOrThrow } from "../common/restaurant-reachability.util";
import {
  BILL_REVENUE_ACCOUNTS,
  countCapturesForRestaurantShifts,
  netAfterMidnightForShift,
  netForRestaurantShifts,
  netTipsByMembershipForRestaurantShifts,
} from "../ledger/restaurant-ledger-window.util";
import { ShiftService } from "../shift/shift.service";
import { PrismaService } from "../prisma/prisma.service";

const RECENT_PAYMENTS_LIMIT = 10;
const TOP_STAFF_LIMIT = 5;
const REVENUE_CHART_SHIFTS = 7;

export interface DashboardRecentPayment {
  id: string;
  grossAmount: string;
  currency: string;
  status: Transaction["status"];
  createdAt: Date;
}

export interface DashboardTopStaffEntry {
  membershipId: string;
  /** ADR-033 added User.displayName; ADR-026 predated it and shipped email alone. This is the
   * human-readable label the screen shows — email stays as the stable, unique identifier beside
   * it, since two staff members can share a display name. */
  displayName: string;
  email: string;
  tips: string;
}

export interface DashboardRevenueChartPoint {
  /** The shift's business date — its name, not a calendar bucket. Two shifts can share one when
   * a venue trades twice in a day, and the chart shows both rather than summing them. */
  date: string;
  /** Which shift this point is, so a screen can link to it and so two points sharing a business
   * date are distinguishable. */
  shiftId: string;
  revenue: string;
}

// ADR-026: todayRevenue is gross sales, before the platform fee is deducted — a different
// figure from Transaction Details' netRestaurantRevenue (ADR-025), which nets the fee out. The
// two screens can show two different, both-correct numbers for what looks like the same word,
// "revenue" — the Founder's own instruction, once that's true, is that the difference must be
// explicit on screen, not only in documentation. This exact string is what a future frontend
// renders as the field's caption/tooltip — fixed and versioned here, not invented client-side.
const TODAY_REVENUE_NOTE = "Before platform fee deduction";

export interface DashboardShift {
  id: string;
  /** The venue's own name for this working day, e.g. "2026-09-02" — not a window (ADR-064). */
  businessDate: string;
  openedAt: Date;
  /** Null while the shift is open. */
  closedAt: Date | null;
  /** "button" | "scheduled", null while open — which of the two ways it ended (ADR-064 §2). */
  closeReason: string | null;
  /** True when the shift was still open past the midnight ending its business date.
   * **Not a warning.** A shift closing at 01:30 is normal; this is information (ADR-065). */
  closedAfterMidnight: boolean;
  /**
   * Money that arrived between that midnight and the close, in minor units.
   *
   * **ADR-065's central figure: the number that explains why a Z-report and a bank statement
   * differ, instead of hiding it.** `"0"` for a shift that closed before midnight — a real zero,
   * not absent data, which is why it is not nullable.
   */
  afterMidnightRevenue: string;
}

export interface DashboardSummary {
  restaurantId: string;
  /**
   * The shift this summary is about (ADR-065): the open one, or the most recently closed when
   * the venue has none open — so the screen is not blank at 06:00 before the first sale.
   * Null only for a venue that has never traded, in which case every figure below is zero-shaped.
   */
  shift: DashboardShift | null;
  /**
   * **Every figure below is scoped to that shift, not to a calendar day** (ADR-065). The fields
   * were named `today*` while this screen counted calendar days; they are named `shift*` now
   * because ADR-065 requires a screen to state which day it means, and a field called "today" on
   * a shift-scoped number would be the exact ambiguity that rule exists to remove.
   */
  shiftRevenue: string;
  /** Always this exact caption (ADR-026) — a constant, not computed. */
  shiftRevenueNote: string;
  shiftTips: string;
  /** Basis points, `null` (never "0") when shiftRevenue is exactly 0 — ADR-025's precedent. */
  averageTipBasisPoints: string | null;
  /** A count of sales on this shift, not of ledger activity. */
  shiftTransactions: number;
  /** shiftRevenue / shiftTransactions, `null` (never "0") when there were none. */
  averageBill: string | null;
  /** The last 7 SHIFTS, oldest first — not the last 7 calendar days (ADR-065). Fewer than 7 for
   * a venue that has not traded that long: a working day that never happened is not a zero. */
  revenueChart: DashboardRevenueChartPoint[];
  recentPayments: DashboardRecentPayment[];
  topStaff: DashboardTopStaffEntry[];
}

/** IMPLEMENTATION_PLAN.md, Sprint 9 (Dashboard). DoD: "Dashboard figures match a manual sum over
 * LedgerLine" — every money figure here is a live SUM(CREDIT)-SUM(DEBIT) aggregation, the same
 * pattern already used by WalletProjectionService.recomputeBalance (ADR-024) and
 * TransactionService.computeBreakdown (ADR-025), never a read of Payment/Transaction fields
 * directly. See ADR-026 for the full reasoning this module implements, in particular why
 * "Today's Revenue" here is deliberately NOT the same quantity as ADR-025's `netRestaurantRevenue`
 * (that one nets out the platform fee; this one is bill-only sales, before either the platform
 * fee's or the tip's split — the SUM(billAmount) an owner means by "how much business did we do
 * today"). */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shifts: ShiftService,
  ) {}

  async getSummary(restaurantId: string, user: AuthenticatedUser): Promise<DashboardSummary> {
    const restaurant = await getReachableReportingRestaurantOrThrow(
      this.prisma,
      restaurantId,
      user,
    );

    const shift = await this.shifts.currentShift(restaurantId);

    // A venue that has never traded has no shift and therefore no figures. Zero-shaped rather
    // than an error: an owner opening the Dashboard on day one is not a failure case.
    if (!shift) {
      return {
        restaurantId,
        shift: null,
        shiftRevenue: "0",
        shiftRevenueNote: TODAY_REVENUE_NOTE,
        shiftTips: "0",
        averageTipBasisPoints: null,
        shiftTransactions: 0,
        averageBill: null,
        revenueChart: [],
        recentPayments: await this.recentPayments(restaurantId),
        topStaff: [],
      };
    }

    const shiftIds = [shift.id];
    const [shiftRevenue, shiftTips, shiftTransactions, revenueChart, recentPayments, topStaff] =
      await Promise.all([
        netForRestaurantShifts(this.prisma, restaurantId, BILL_REVENUE_ACCOUNTS, shiftIds),
        netForRestaurantShifts(this.prisma, restaurantId, ["TIP_PAYABLE"], shiftIds),
        countCapturesForRestaurantShifts(this.prisma, restaurantId, shiftIds),
        this.buildRevenueChart(restaurant),
        this.recentPayments(restaurantId),
        this.topStaff(restaurantId, shiftIds),
      ]);

    const midnight = this.shifts.midnightEndingBusinessDate(
      shift.businessDate,
      restaurant.timezone,
    );
    const afterMidnightRevenue = await netAfterMidnightForShift(
      this.prisma,
      restaurantId,
      shift.id,
      midnight,
    );

    return {
      restaurantId,
      shift: {
        id: shift.id,
        businessDate: shift.businessDate.toISOString().slice(0, 10),
        openedAt: shift.openedAt,
        closedAt: shift.closedAt,
        closeReason: shift.closeReason,
        closedAfterMidnight: this.shifts.closedAfterMidnight(shift, restaurant.timezone),
        afterMidnightRevenue: afterMidnightRevenue.toString(),
      },
      shiftRevenue: shiftRevenue.toString(),
      shiftRevenueNote: TODAY_REVENUE_NOTE,
      shiftTips: shiftTips.toString(),
      averageTipBasisPoints: this.averageTipBasisPoints(shiftTips, shiftRevenue),
      shiftTransactions,
      averageBill: this.averageBill(shiftRevenue, shiftTransactions),
      revenueChart,
      recentPayments,
      topStaff,
    };
  }

  /** Today's Revenue ÷ today's transaction count, floored to minor units.
   *
   * **The zero case is the whole reason this is a named method.** With no transactions there is
   * no divisor: a naive implementation either divides by zero or returns "0", and "0" is a lie —
   * it says the average bill today was nothing, when the truth is that there were no bills. The
   * test for this asserts `null`, and both naive versions fail it. */
  private averageBill(todayRevenue: bigint, todayTransactions: number): string | null {
    if (todayTransactions === 0) return null;
    return (todayRevenue / BigInt(todayTransactions)).toString();
  }

  /** Ratio of the two SUMS already computed above, not an average of each transaction's own
   * tip% — the Founder's explicit correction: a customer who tips 50% on a €2 coffee should not
   * pull the average toward 50% as heavily as a €2 tip on a €200 dinner bill would, if both were
   * weighted equally as "one transaction" instead of by the money actually involved. */
  private averageTipBasisPoints(todayTips: bigint, todayRevenue: bigint): string | null {
    if (todayRevenue === 0n) return null;
    return ((todayTips * 10_000n) / todayRevenue).toString();
  }

  /** Last 7 local calendar days including today, oldest first — same netBillRevenue definition
   * as the single Today's Revenue figure, one call per day (7 is small and fixed; no raw SQL
   * date_trunc needed for this scale — same "explicit over implicit, O(n) is fine at this size"
   * reasoning as WalletProjectionService's full recompute, ADR-024). */
  /** The last 7 SHIFTS, oldest first (ADR-065) — not the last 7 calendar days. A venue that
   * traded on five of the last seven days gets five points, not seven with two zeros: a working
   * day that never happened is not a day with no revenue. */
  private async buildRevenueChart(restaurant: Restaurant): Promise<DashboardRevenueChartPoint[]> {
    const shifts = await this.shifts.recentShifts(restaurant.id, REVENUE_CHART_SHIFTS);
    const points: DashboardRevenueChartPoint[] = [];
    for (const shift of shifts) {
      const revenue = await netForRestaurantShifts(
        this.prisma,
        restaurant.id,
        BILL_REVENUE_ACCOUNTS,
        [shift.id],
      );
      points.push({
        date: shift.businessDate.toISOString().slice(0, 10),
        shiftId: shift.id,
        revenue: revenue.toString(),
      });
    }
    return points;
  }

  private async recentPayments(restaurantId: string): Promise<DashboardRecentPayment[]> {
    const rows = await this.prisma.transaction.findMany({
      where: { restaurantId },
      orderBy: { createdAt: "desc" },
      take: RECENT_PAYMENTS_LIMIT,
    });
    return rows.map((t) => ({
      id: t.id,
      grossAmount: t.grossAmount.toString(),
      currency: t.currency,
      status: t.status,
      createdAt: t.createdAt,
    }));
  }

  /** Ranked by today's net TIP_PAYABLE per membershipId — same SUM(CREDIT)-SUM(DEBIT) pattern as
   * WalletProjectionService.recomputeBalance, scoped to today and this Restaurant instead of a
   * Membership's whole history. A refund posted today against an older tip-bearing payment can
   * make one membership's net lower (even negative) — correct, not a bug, same day-boundary
   * reasoning as netBillRevenue above; "top" ordering handles it without a special case.
   *
   * Returns `displayName` alongside `email`. ADR-026 originally shipped email alone and recorded
   * why as a known limitation — `User` genuinely had no name field at that point. ADR-033 then
   * added `User.displayName` (required, for the terminal's staff picker) and nothing came back to
   * close the loop here, so a screen that exists to name people kept showing addresses. `email` is
   * kept beside it rather than replaced: it is the stable identifier, and two staff members can
   * share a display name while addresses are unique. */
  private async topStaff(
    restaurantId: string,
    shiftIds: string[],
  ): Promise<DashboardTopStaffEntry[]> {
    const netByMembership = await netTipsByMembershipForRestaurantShifts(
      this.prisma,
      restaurantId,
      shiftIds,
    );

    const ranked = [...netByMembership.entries()]
      .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
      .slice(0, TOP_STAFF_LIMIT);

    if (ranked.length === 0) return [];

    const memberships = await this.prisma.membership.findMany({
      where: { id: { in: ranked.map(([id]) => id) } },
      include: { user: { select: { email: true, displayName: true } } },
    });
    const userByMembership = new Map(memberships.map((m) => [m.id, m.user]));

    return ranked.map(([membershipId, tips]) => {
      const u = userByMembership.get(membershipId);
      return {
        membershipId,
        displayName: u?.displayName ?? "",
        email: u?.email ?? "",
        tips: tips.toString(),
      };
    });
  }
}
