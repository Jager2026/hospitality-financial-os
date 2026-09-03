import type { LedgerAccount } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";

// ADR-026's own definition of "Today's Revenue" (bill-only sales, before the platform fee):
// net(RESTAURANT_REVENUE_PAYABLE) + net(PLATFORM_FEE_REVENUE). Named here so Dashboard and
// Analytics both reference the same two-account definition, not two copies of the same list.
export const BILL_REVENUE_ACCOUNTS: LedgerAccount[] = [
  "RESTAURANT_REVENUE_PAYABLE",
  "PLATFORM_FEE_REVENUE",
];

/** SUM(CREDIT) - SUM(DEBIT) across `accounts`, scoped to one Restaurant and one half-open
 * [start, end) window on `LedgerLine.createdAt` — the same account-balance definition used
 * everywhere else in this system (`WalletProjectionService.recomputeBalance`, ADR-024;
 * `TransactionService.computeBreakdown`, ADR-025). Shared here because Dashboard (ADR-026) and
 * Analytics (Sprint 10) both need the identical restaurant-and-window-scoped version of it — one
 * implementation, not two independently-maintained copies of the same formula that could drift
 * apart (the exact failure mode ADR-021 already warns against for fee-splitting). */
export async function netForRestaurantWindow(
  prisma: PrismaService,
  restaurantId: string,
  accounts: LedgerAccount[],
  start: Date,
  end: Date,
): Promise<bigint> {
  const groups = await prisma.ledgerLine.groupBy({
    by: ["direction"],
    where: { restaurantId, account: { in: accounts }, createdAt: { gte: start, lt: end } },
    _sum: { amount: true },
  });
  const credit = groups.find((g) => g.direction === "CREDIT")?._sum.amount ?? 0n;
  const debit = groups.find((g) => g.direction === "DEBIT")?._sum.amount ?? 0n;
  return credit - debit;
}

/** Same net-balance definition as `netForRestaurantWindow`, grouped per `membershipId` instead of
 * collapsed to one total — the shared basis for Dashboard's Top Staff (ADR-026) and Analytics'
 * full Staff list (Sprint 10): `SUM(CREDIT)-SUM(DEBIT)` of `TIP_PAYABLE` per person, never a naive
 * sum of credits alone (ADR-023's own bug class — a same-day refund must reduce a person's net,
 * not just add to it). */
export async function netTipsByMembershipForRestaurantWindow(
  prisma: PrismaService,
  restaurantId: string,
  start: Date,
  end: Date,
): Promise<Map<string, bigint>> {
  const groups = await prisma.ledgerLine.groupBy({
    by: ["membershipId", "direction"],
    where: {
      restaurantId,
      account: "TIP_PAYABLE",
      membershipId: { not: null },
      createdAt: { gte: start, lt: end },
    },
    _sum: { amount: true },
  });

  const netByMembership = new Map<string, bigint>();
  for (const g of groups) {
    const membershipId = g.membershipId as string;
    const signed = g.direction === "CREDIT" ? (g._sum.amount ?? 0n) : -(g._sum.amount ?? 0n);
    netByMembership.set(membershipId, (netByMembership.get(membershipId) ?? 0n) + signed);
  }
  return netByMembership;
}

// ============================================================================
// ADR-065: the same two aggregations, scoped by SHIFT instead of by calendar window.
//
// Deliberately new functions rather than an extra optional argument on the calendar ones. The
// caller of a figure must state which day it means (ADR-065's own rule), and a boolean or a
// nullable `shiftIds` parameter would let a call site be ambiguous about it — which is the defect
// this whole line of work exists to remove. Two names, each unambiguous at the call site.
//
// The aggregation itself is unchanged: SUM(CREDIT) - SUM(DEBIT), same as everywhere else in this
// system. What changes is which rows are selected.
// ============================================================================

/** `netForRestaurantWindow`'s definition, over a set of Shifts instead of a time range. */
export async function netForRestaurantShifts(
  prisma: PrismaService,
  restaurantId: string,
  accounts: LedgerAccount[],
  shiftIds: string[],
): Promise<bigint> {
  if (shiftIds.length === 0) return 0n;

  const groups = await prisma.ledgerLine.groupBy({
    by: ["direction"],
    where: { restaurantId, account: { in: accounts }, shiftId: { in: shiftIds } },
    _sum: { amount: true },
  });
  const credit = groups.find((g) => g.direction === "CREDIT")?._sum.amount ?? 0n;
  const debit = groups.find((g) => g.direction === "DEBIT")?._sum.amount ?? 0n;
  return credit - debit;
}

/** `netTipsByMembershipForRestaurantWindow`'s definition, over a set of Shifts. */
export async function netTipsByMembershipForRestaurantShifts(
  prisma: PrismaService,
  restaurantId: string,
  shiftIds: string[],
): Promise<Map<string, bigint>> {
  if (shiftIds.length === 0) return new Map();

  const groups = await prisma.ledgerLine.groupBy({
    by: ["membershipId", "direction"],
    where: {
      restaurantId,
      account: "TIP_PAYABLE",
      membershipId: { not: null },
      shiftId: { in: shiftIds },
    },
    _sum: { amount: true },
  });

  const netByMembership = new Map<string, bigint>();
  for (const g of groups) {
    const membershipId = g.membershipId as string;
    const signed = g.direction === "CREDIT" ? (g._sum.amount ?? 0n) : -(g._sum.amount ?? 0n);
    netByMembership.set(membershipId, (netByMembership.get(membershipId) ?? 0n) + signed);
  }
  return netByMembership;
}

/** Sales on a set of Shifts: one per PAYMENT_CAPTURED entry, counted over the lines' own shift
 * label rather than a date window. The shift-scoped twin of Dashboard's `todayTransactionCount`. */
export async function countCapturesForRestaurantShifts(
  prisma: PrismaService,
  restaurantId: string,
  shiftIds: string[],
): Promise<number> {
  if (shiftIds.length === 0) return 0;

  const entries = await prisma.ledgerLine.groupBy({
    by: ["journalEntryId"],
    where: {
      restaurantId,
      shiftId: { in: shiftIds },
      journalEntry: { entryType: "PAYMENT_CAPTURED" },
    },
  });
  return entries.length;
}

/**
 * Money on ONE shift that arrived after the midnight ending its business date — ADR-065's
 * "how much came in between midnight and the close".
 *
 * **The ADR's own wording needed correcting to be implementable, and the correction is recorded
 * rather than silently applied.** It said "after local midnight of the shift's own
 * `businessDate`", which is the midnight that *starts* that date and would include the entire
 * evening. What the owner is being told is what arrived after the midnight that *ends* it —
 * `businessDate + 1 day`, local. That is the figure that explains a Z-report differing from a
 * bank statement.
 *
 * Zero for a shift that closed before midnight, which is the common case and not an error.
 */
export async function netAfterMidnightForShift(
  prisma: PrismaService,
  restaurantId: string,
  shiftId: string,
  midnightEndingBusinessDate: Date,
): Promise<bigint> {
  const groups = await prisma.ledgerLine.groupBy({
    by: ["direction"],
    where: {
      restaurantId,
      account: { in: BILL_REVENUE_ACCOUNTS },
      shiftId,
      createdAt: { gte: midnightEndingBusinessDate },
    },
    _sum: { amount: true },
  });
  const credit = groups.find((g) => g.direction === "CREDIT")?._sum.amount ?? 0n;
  const debit = groups.find((g) => g.direction === "DEBIT")?._sum.amount ?? 0n;
  return credit - debit;
}

/**
 * `netForRestaurantWindow`'s definition, restricted to lines that carry NO Shift.
 *
 * **This exists because a shift-scoped financial export would otherwise lose money silently.**
 * ADR-065's own Consequences say it: rows written before ADR-064 have no `shiftId`, and no
 * backfill can honestly repair them — there is no record of when those venues closed their days.
 * A by-shift export over such a period therefore omits real money, and a file that omits money
 * without saying so is worse than no file at all for an accountant.
 *
 * So the by-shift exports end with an explicit `unassigned` row computed by this function, over
 * the same calendar window the caller asked for. It is not a total that reconciles against the
 * by-calendar-day export — the two partitions genuinely differ at the range edges, which is the
 * whole reason both lists exist (ADR-065 §3) — it is a statement of what the shift cut cannot see.
 */
export async function netForRestaurantWindowWithoutShift(
  prisma: PrismaService,
  restaurantId: string,
  accounts: LedgerAccount[],
  start: Date,
  end: Date,
): Promise<bigint> {
  const groups = await prisma.ledgerLine.groupBy({
    by: ["direction"],
    where: {
      restaurantId,
      account: { in: accounts },
      shiftId: null,
      createdAt: { gte: start, lt: end },
    },
    _sum: { amount: true },
  });
  const credit = groups.find((g) => g.direction === "CREDIT")?._sum.amount ?? 0n;
  const debit = groups.find((g) => g.direction === "DEBIT")?._sum.amount ?? 0n;
  return credit - debit;
}
