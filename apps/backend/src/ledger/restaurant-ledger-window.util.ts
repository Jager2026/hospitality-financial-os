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
