import { Injectable } from "@nestjs/common";
import type { Wallet } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { AppException } from "../common/exceptions/app.exception";
import { PrismaService } from "../prisma/prisma.service";

export interface WalletSummary {
  id: string;
  membershipId: string;
  restaurantId: string | null;
  restaurantName: string | null;
  organizationId: string;
  availableBalance: string;
  pendingBalance: string;
  currency: string;
  status: string;
}

export interface WalletTransactionEntry {
  ledgerLineId: string;
  account: string;
  direction: string;
  amount: string;
  currency: string;
  restaurantId: string | null;
  transactionId: string | null;
  entryType: string;
  createdAt: Date;
}

type WalletWithMembership = Wallet & {
  membership: {
    restaurantId: string | null;
    organizationId: string;
    restaurant: { name: string } | null;
  };
};

// API_Contract.md, WALLETS. Read-only for MVP — there is no POST /wallets, a Wallet is only ever
// created by WalletProjectionService's own upsert (ADR-024), never by direct client request.
@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  // "My Wallets" — every Wallet backing one of the caller's own Memberships (ADR-006: one per
  // employer, never merged). No reachability check needed: membershipId is already scoped to the
  // caller's own memberships by construction of the WHERE clause below (same pattern as
  // TipService.findMine).
  async findMine(user: AuthenticatedUser): Promise<WalletSummary[]> {
    const membershipIds = user.memberships.map((m) => m.id);
    if (membershipIds.length === 0) return [];

    const wallets = await this.prisma.wallet.findMany({
      where: { membershipId: { in: membershipIds } },
      include: { membership: { include: { restaurant: { select: { name: true } } } } },
      orderBy: { createdAt: "asc" },
    });

    return wallets.map((w) => this.toSummary(w));
  }

  async findOne(id: string, user: AuthenticatedUser): Promise<Wallet> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id },
      include: { membership: { include: { restaurant: { select: { name: true } } } } },
    });
    if (!wallet) {
      throw new AppException("WALLET_NOT_FOUND", "Wallet not found.", 404);
    }
    this.assertReachable(wallet, user);
    return wallet;
  }

  /** ADR-039: the Employee Details screen's own route to a staff member's Wallet. Before this, an
   * Owner could be *allowed* to view an employee's Wallet (assertReachable below has permitted it
   * since ADR-024) and still have no way to reach it — `GET /wallets` returns only the caller's
   * own, so the id that `GET /wallets/{id}` needs came from nowhere. A permission with no
   * addressable resource behind it.
   *
   * Deliberately reuses `assertReachable` unchanged rather than restating the rule. Two copies of
   * an access check drift, and the one that drifts is the one nobody is looking at — the same
   * "never two independently-maintained copies of a decision" reasoning applied to money in
   * ADR-021 and to reachability itself in ADR-026/027. */
  async findByMembership(membershipId: string, user: AuthenticatedUser): Promise<Wallet> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { membershipId },
      include: { membership: { include: { restaurant: { select: { name: true } } } } },
    });
    // Same 404 as an unreachable Wallet, deliberately: "this Membership has no Wallet yet" and
    // "you may not see it" must be indistinguishable to the caller, or the response becomes an
    // existence oracle for Memberships in other Organizations.
    if (!wallet) {
      throw new AppException("WALLET_NOT_FOUND", "Wallet not found.", 404);
    }
    this.assertReachable(wallet, user);
    return wallet;
  }

  // API_Contract.md: "Ledger-derived history for this Wallet only" — reads LedgerLine directly
  // (ADR-002: the Ledger is the source of truth; Wallet itself is only ever a cached projection
  // of it), not a stored transaction log on Wallet.
  async findTransactions(id: string, user: AuthenticatedUser): Promise<WalletTransactionEntry[]> {
    const wallet = await this.findOne(id, user); // reuses the same reachability check

    const lines = await this.prisma.ledgerLine.findMany({
      where: { membershipId: wallet.membershipId },
      include: { journalEntry: { select: { entryType: true, transactionId: true } } },
      orderBy: { createdAt: "desc" },
    });

    return lines.map((line) => ({
      ledgerLineId: line.id,
      account: line.account,
      direction: line.direction,
      amount: line.amount.toString(),
      currency: line.currency,
      restaurantId: line.restaurantId,
      transactionId: line.journalEntry.transactionId,
      entryType: line.journalEntry.entryType,
      createdAt: line.createdAt,
    }));
  }

  private toSummary(wallet: WalletWithMembership): WalletSummary {
    return {
      id: wallet.id,
      membershipId: wallet.membershipId,
      restaurantId: wallet.membership.restaurantId,
      restaurantName: wallet.membership.restaurant?.name ?? null,
      organizationId: wallet.membership.organizationId,
      availableBalance: wallet.availableBalance.toString(),
      pendingBalance: wallet.pendingBalance.toString(),
      currency: wallet.currency,
      status: wallet.status,
    };
  }

  // Same reachability rule as everywhere else (ADR-005): the Wallet's own Membership, or a
  // Membership reaching that Wallet's Restaurant (org-wide same-Organization, or restaurant-
  // scoped same-Restaurant) — e.g. an Owner viewing an employee's Wallet on the Employee Details
  // screen (UX_MAP.md). An org-wide Wallet owner (restaurantId null — e.g. an Owner who
  // personally took a payment) has no Restaurant to check reachability against, so nobody but
  // that Membership's own holder can view it — never widened to "any org-wide Membership
  // anywhere" (the exact bug CLAUDE_RULES.md now requires checking for on every new access check
  // of this shape).
  private assertReachable(wallet: WalletWithMembership, user: AuthenticatedUser): void {
    const isOwnWallet = user.memberships.some((m) => m.id === wallet.membershipId);
    if (isOwnWallet) return;

    const reachable =
      wallet.membership.restaurantId !== null &&
      user.memberships.some(
        (m) =>
          m.restaurantId === wallet.membership.restaurantId ||
          (m.restaurantId === null && m.organizationId === wallet.membership.organizationId),
      );
    if (!reachable) {
      throw new AppException("WALLET_NOT_FOUND", "Wallet not found.", 404);
    }
  }
}
