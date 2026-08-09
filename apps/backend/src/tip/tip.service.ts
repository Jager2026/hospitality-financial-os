import { Injectable } from "@nestjs/common";
import type { Tip } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { AppException } from "../common/exceptions/app.exception";
import { PrismaService } from "../prisma/prisma.service";

export interface TipHistoryEntry {
  tipId: string;
  transactionId: string;
  restaurantId: string;
  amount: string; // this recipient's own credited share, not necessarily the full gross tip
  currency: string;
  createdAt: Date;
}

// API_Contract.md, TIPS. Read-only — there is no POST /tips (ADR-007/ADR-022: a Tip is written
// server-side as part of payment confirmation, never by direct client call).
@Injectable()
export class TipService {
  constructor(private readonly prisma: PrismaService) {}

  async findOne(id: string, user: AuthenticatedUser): Promise<Tip> {
    const tip = await this.prisma.tip.findUnique({
      where: { id },
      include: { transaction: { select: { restaurantId: true } } },
    });
    if (!tip) {
      throw new AppException("NOT_FOUND", "Tip not found.", 404);
    }
    await this.assertReachable(tip.transaction.restaurantId, user);
    return tip;
  }

  // "My Tips" — API_Contract.md: "aggregated across every Membership the current user holds."
  // Reads the Ledger itself (LedgerLine, account=TIP_PAYABLE, direction=CREDIT), not
  // Payment.waiterMembershipId — the source of truth for who a tip was actually allocated to is
  // the TIP_ALLOCATED entry's credit lines (ADR-022), which is also the only shape that stays
  // correct once a future Pool/Shift/Percentage/Role-based strategy can credit more than one
  // Membership from a single tip. No reachability check needed here: membershipId is already
  // scoped to the caller's own memberships by construction of the WHERE clause below.
  async findMine(user: AuthenticatedUser): Promise<TipHistoryEntry[]> {
    const membershipIds = user.memberships.map((m) => m.id);
    if (membershipIds.length === 0) return [];

    const lines = await this.prisma.ledgerLine.findMany({
      where: { account: "TIP_PAYABLE", direction: "CREDIT", membershipId: { in: membershipIds } },
      include: {
        journalEntry: {
          include: { transaction: { include: { tip: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return this.toHistoryEntries(lines);
  }

  // API_Contract.md, Restaurant Tips.
  async findForRestaurant(restaurantId: string, user: AuthenticatedUser): Promise<TipHistoryEntry[]> {
    await this.assertReachable(restaurantId, user);

    const lines = await this.prisma.ledgerLine.findMany({
      where: {
        account: "TIP_PAYABLE",
        direction: "CREDIT",
        // Not "not: null" as a style choice — a real bug caught by live verification, not a test:
        // PAYMENT_CAPTURED's own 4th line (ADR-022) is ALSO account=TIP_PAYABLE, direction=CREDIT
        // — the general, not-yet-attributed liability, membershipId always null. Without this
        // filter, this query double-counted every tip: once from PAYMENT_CAPTURED's general
        // credit, once from TIP_ALLOCATED's real, person-attributed one. findMine() never had this
        // bug — its own membershipId: { in: ... } filter already excludes null incidentally.
        membershipId: { not: null },
        journalEntry: { transaction: { restaurantId } },
      },
      include: {
        journalEntry: {
          include: { transaction: { include: { tip: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return this.toHistoryEntries(lines);
  }

  private toHistoryEntries(
    lines: Array<{
      amount: bigint;
      currency: string;
      createdAt: Date;
      journalEntry: {
        transaction: { id: string; restaurantId: string; tip: Tip | null } | null;
      };
    }>,
  ): TipHistoryEntry[] {
    return lines
      .filter((line) => line.journalEntry.transaction?.tip) // defensive: every TIP_PAYABLE credit line is written alongside a Tip row (ADR-022) — filtered rather than assumed, so a data inconsistency surfaces as a missing entry, not a crash
      .map((line) => {
        const transaction = line.journalEntry.transaction!;
        return {
          tipId: transaction.tip!.id,
          transactionId: transaction.id,
          restaurantId: transaction.restaurantId,
          amount: line.amount.toString(),
          currency: line.currency,
          createdAt: line.createdAt,
        };
      });
  }

  // Same reachability rule as everywhere else (ADR-005, e.g. PaymentService's own
  // getReachableRestaurantOrThrow): a restaurant-scoped Membership on this exact restaurant, or
  // an org-wide Membership (restaurantId null) on the SAME organizationId this restaurant belongs
  // to — never just "any org-wide membership anywhere," which would leak one organization's tips
  // to a completely unrelated org-wide Owner.
  private async assertReachable(restaurantId: string, user: AuthenticatedUser): Promise<void> {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { id: restaurantId, deletedAt: null },
      select: { id: true, organizationId: true },
    });
    if (!restaurant) {
      throw new AppException("NOT_FOUND", "Restaurant not found.", 404);
    }
    const reachable = user.memberships.some(
      (m) =>
        m.restaurantId === restaurant.id ||
        (m.restaurantId === null && m.organizationId === restaurant.organizationId),
    );
    if (!reachable) {
      throw new AppException("NOT_FOUND", "Restaurant not found.", 404);
    }
  }
}
