import { Injectable } from "@nestjs/common";
import type { Restaurant, Transaction } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { getReachableReportingRestaurantOrThrow } from "../common/restaurant-reachability.util";
import { getLocalDayWindow } from "../common/timezone-day.util";
import {
  BILL_REVENUE_ACCOUNTS,
  netForRestaurantWindow,
  netTipsByMembershipForRestaurantWindow,
} from "../ledger/restaurant-ledger-window.util";
import { PrismaService } from "../prisma/prisma.service";

const RECENT_PAYMENTS_LIMIT = 10;
const TOP_STAFF_LIMIT = 5;
const REVENUE_CHART_DAYS = 7;

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
  date: string;
  revenue: string;
}

// ADR-026: todayRevenue is gross sales, before the platform fee is deducted — a different
// figure from Transaction Details' netRestaurantRevenue (ADR-025), which nets the fee out. The
// two screens can show two different, both-correct numbers for what looks like the same word,
// "revenue" — the Founder's own instruction, once that's true, is that the difference must be
// explicit on screen, not only in documentation. This exact string is what a future frontend
// renders as the field's caption/tooltip — fixed and versioned here, not invented client-side.
const TODAY_REVENUE_NOTE = "Before platform fee deduction";

export interface DashboardSummary {
  restaurantId: string;
  date: string;
  todayRevenue: string;
  /** Always this exact caption (ADR-026) — a constant, not computed, so a future frontend never
   * has to invent or duplicate the explanation of what todayRevenue does and doesn't include. */
  todayRevenueNote: string;
  todayTips: string;
  /** Basis points (e.g. "3333" = 33.33%), ADR-021's own vocabulary for percentage-as-integer —
   * never a float. `null`, not "0", when todayRevenue is exactly 0: there is no meaningful ratio
   * yet, and "0" would misrepresent "no data" as "a real 0% tip rate" (ADR-025's null-not-0
   * precedent). */
  averageTipBasisPoints: string | null;
  /** UX_MAP: "Today's Transactions is a count, not a list." A count of SALES made today —
   * PAYMENT_CAPTURED entries dated today — not of ledger activity. A refund posted today against
   * an older sale moves `todayRevenue` (ADR-026, deliberately) but is not a transaction that
   * happened today, so it must not move this. A plain number, not a minor-units string: it is a
   * count, and typing it like money would invite someone to treat it as money. */
  todayTransactions: number;
  /** UX_MAP: Today's Revenue ÷ today's transaction count. Same ratio-of-sums discipline as
   * `averageTipBasisPoints` (ADR-026 Decision 4) — divide the totals, never average each
   * transaction's own figure. **`null`, never "0", when there were no transactions today**:
   * "no data yet" and "an average of zero" are different statements (ADR-025's null-not-0
   * precedent), and the divisor does not exist. It CAN be negative when today's refunds of older
   * sales exceed today's takings — UX_MAP requires the screen to render that rather than clamp
   * it, and this figure is not clamped here either. */
  averageBill: string | null;
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
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(restaurantId: string, user: AuthenticatedUser): Promise<DashboardSummary> {
    const restaurant = await getReachableReportingRestaurantOrThrow(
      this.prisma,
      restaurantId,
      user,
    );

    const today = getLocalDayWindow(restaurant.timezone, 0);
    const [todayRevenue, todayTips, todayTransactions, revenueChart, recentPayments, topStaff] =
      await Promise.all([
        this.netBillRevenue(restaurantId, today.start, today.end),
        this.netTips(restaurantId, today.start, today.end),
        this.todayTransactionCount(restaurantId, today.start, today.end),
        this.buildRevenueChart(restaurant),
        this.recentPayments(restaurantId),
        this.topStaff(restaurantId, today.start, today.end),
      ]);

    return {
      restaurantId,
      date: today.date,
      todayRevenue: todayRevenue.toString(),
      todayRevenueNote: TODAY_REVENUE_NOTE,
      todayTips: todayTips.toString(),
      averageTipBasisPoints: this.averageTipBasisPoints(todayTips, todayRevenue),
      todayTransactions,
      averageBill: this.averageBill(todayRevenue, todayTransactions),
      revenueChart,
      recentPayments,
      topStaff,
    };
  }

  /** "Today's Revenue" = bill-only sales, net of any refund/chargeback activity dated today,
   * regardless of which day the original sale happened on (see ADR-026 for why this is correct,
   * not a bug — a refund posted today correctly reduces today's total, not the original sale
   * day's, matching how every other day's own already-posted LedgerLine activity stays fixed
   * once that day has passed). Computed as net(RESTAURANT_REVENUE_PAYABLE) + net(PLATFORM_FEE_
   * REVENUE) (`restaurant-ledger-window.util.ts`): together these always equal billAmount net of
   * refunds — ADR-023's proportional reversal splits exactly along these two accounts for the
   * non-tip share of any refund, so the sum is provably billAmount's own net effect, not an
   * approximation. */
  private async netBillRevenue(restaurantId: string, start: Date, end: Date): Promise<bigint> {
    return netForRestaurantWindow(this.prisma, restaurantId, BILL_REVENUE_ACCOUNTS, start, end);
  }

  /** net(TIP_PAYABLE), unfiltered by membershipId — PAYMENT_CAPTURED's general, not-yet-attributed
   * credit and TIP_ALLOCATED's own reversal of it cancel to zero by construction (ADR-022/025),
   * leaving only the real, person-attributed tip total minus anything refunded today. */
  private async netTips(restaurantId: string, start: Date, end: Date): Promise<bigint> {
    return netForRestaurantWindow(this.prisma, restaurantId, ["TIP_PAYABLE"], start, end);
  }

  /** Count of SALES dated today: one per PAYMENT_CAPTURED JournalEntry on this Restaurant's
   * Transactions inside the local-day window. Counted from the Ledger, like every other figure
   * on this screen, rather than from Transaction.createdAt — a Transaction row's own timestamp
   * and its capture entry's are written in the same request today, but the Ledger is the source
   * of truth for when money moved (ADR-002), and the two must not be allowed to drift apart into
   * two different answers to "how many sales today". */
  private async todayTransactionCount(
    restaurantId: string,
    start: Date,
    end: Date,
  ): Promise<number> {
    // Counted over LedgerLine.createdAt, NOT JournalEntry.createdAt. The two are written in the
    // same request today and look interchangeable; they are not, and this test caught the
    // difference: every other figure on this screen defines the day by LedgerLine.createdAt
    // (ADR-026), so counting by the entry's own timestamp would give "how many sales today" a
    // different day boundary from "today's revenue" — the exact drift the comment above claims
    // to avoid. One PAYMENT_CAPTURED entry is one sale, so distinct entries are the count.
    const entries = await this.prisma.ledgerLine.groupBy({
      by: ["journalEntryId"],
      where: {
        restaurantId,
        createdAt: { gte: start, lt: end },
        journalEntry: { entryType: "PAYMENT_CAPTURED" },
      },
    });
    return entries.length;
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
  private async buildRevenueChart(restaurant: Restaurant): Promise<DashboardRevenueChartPoint[]> {
    const points: DashboardRevenueChartPoint[] = [];
    for (let daysAgo = REVENUE_CHART_DAYS - 1; daysAgo >= 0; daysAgo--) {
      const window = getLocalDayWindow(restaurant.timezone, daysAgo);
      const revenue = await this.netBillRevenue(restaurant.id, window.start, window.end);
      points.push({ date: window.date, revenue: revenue.toString() });
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
    start: Date,
    end: Date,
  ): Promise<DashboardTopStaffEntry[]> {
    const netByMembership = await netTipsByMembershipForRestaurantWindow(
      this.prisma,
      restaurantId,
      start,
      end,
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
