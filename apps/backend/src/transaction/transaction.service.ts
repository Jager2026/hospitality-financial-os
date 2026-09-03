import { Injectable } from "@nestjs/common";
import type { LedgerAccount, Transaction } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { AppException } from "../common/exceptions/app.exception";
import { permittedScope } from "../common/restaurant-reachability.util";
import { PrismaService } from "../prisma/prisma.service";
import { hasPermissionAtRestaurant } from "../common/restaurant-reachability.util";
import type {
  TransactionExportQueryDto,
  TransactionListQueryDto,
} from "./dto/transaction-list-query.schema";

/** The permission both the list and the CSV export require (ADR-043). One constant so the route
 * decorators and the query filter can never drift apart — the drift is what the leak was. */
export const TRANSACTION_PERMISSION = "reports.view";

export interface TransactionBreakdown {
  netRestaurantRevenue: string;
  netTip: string;
  netPlatformFee: string;
  tax: string;
  processingFee: null; // ADR-025: never "0" — a real, Stripe-held figure this system cannot see
  refundedAmount: string;
}

export interface TransactionDetails extends TransactionBreakdown {
  id: string;
  restaurantId: string;
  paymentId: string;
  grossAmount: string;
  currency: string;
  status: Transaction["status"];
  createdAt: Date;
  refunds: Array<{
    id: string;
    amount: string;
    reason: string;
    tipRefunded: boolean;
    status: string;
    createdAt: Date;
  }>;
  chargebacks: Array<{
    id: string;
    amount: string;
    reason: string;
    status: string;
    resolvedAt: Date | null;
    createdAt: Date;
  }>;
}

export interface TransactionListEntry {
  id: string;
  restaurantId: string;
  paymentId: string;
  grossAmount: string;
  currency: string;
  /** UX_MAP's Transaction Card promises Amount AND Tip; this list returned only the amount, and
   * unlike the card's missing Staff Member that gap was recorded nowhere (UX_API_RECONCILIATION,
   * section B). Same `net(TIP_PAYABLE)` definition as `TransactionDetails.netTip`, so the card
   * and the detail screen can never show two different tips for one Transaction. */
  tip: string;
  status: Transaction["status"];
  createdAt: Date;
}

export interface TransactionListPage {
  data: TransactionListEntry[];
  meta: { page: number; limit: number; total: number; pages: number };
}

// API_Contract.md, TRANSACTIONS.
@Injectable()
export class TransactionService {
  constructor(private readonly prisma: PrismaService) {}

  async findOne(id: string, user: AuthenticatedUser): Promise<TransactionDetails> {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id },
      include: {
        refunds: { orderBy: { createdAt: "asc" } },
        chargebacks: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!transaction) {
      throw new AppException("NOT_FOUND", "Transaction not found.", 404);
    }
    await this.assertPermittedAtRestaurant(transaction.restaurantId, user);

    const breakdown = await this.computeBreakdown(transaction.id);

    return {
      id: transaction.id,
      restaurantId: transaction.restaurantId,
      paymentId: transaction.paymentId,
      grossAmount: transaction.grossAmount.toString(),
      currency: transaction.currency,
      status: transaction.status,
      createdAt: transaction.createdAt,
      ...breakdown,
      refunds: transaction.refunds.map((r) => ({
        id: r.id,
        amount: r.amount.toString(),
        reason: r.reason,
        tipRefunded: r.tipRefunded,
        status: r.status,
        createdAt: r.createdAt,
      })),
      chargebacks: transaction.chargebacks.map((c) => ({
        id: c.id,
        amount: c.amount.toString(),
        reason: c.reason,
        status: c.status,
        resolvedAt: c.resolvedAt,
        createdAt: c.createdAt,
      })),
    };
  }

  /** ADR-025: `CREDIT` minus `DEBIT` per account, across every `LedgerLine` belonging to ANY
   * `JournalEntry` under this Transaction — not filtered by `entry_type`. That subtraction, per
   * account, is the definition of an account balance in double-entry bookkeeping; it isn't a
   * special algorithm for this case. `tax` is computed the same generic way as everything else
   * here, not hardcoded to `"0"` — `TAX_PAYABLE` simply has no writer yet (ADR-007's "schema
   * ready, not yet used" precedent), so it evaluates to `0` on its own without a special case,
   * and picks up real data automatically the day a real writer exists. These four, plus
   * `refundedAmount`, always sum to exactly `grossAmount` (this Sprint's own Definition of
   * Done) — provable, not coincidental: `PROCESSOR_CLEARING` is debited exactly once, at
   * capture, for the full `grossAmount`, and every `JournalEntry` under this Transaction is
   * individually balanced (`ledger_line_balanced`, the DB trigger), so the sum of every OTHER
   * account's net movement is constrained to equal that one fixed debit. */
  private async computeBreakdown(transactionId: string): Promise<TransactionBreakdown> {
    const groups = await this.prisma.ledgerLine.groupBy({
      by: ["account", "direction"],
      where: { journalEntry: { transactionId } },
      _sum: { amount: true },
    });

    const net = (account: LedgerAccount): bigint => {
      const credit =
        groups.find((g) => g.account === account && g.direction === "CREDIT")?._sum.amount ?? 0n;
      const debit =
        groups.find((g) => g.account === account && g.direction === "DEBIT")?._sum.amount ?? 0n;
      return credit - debit;
    };

    return {
      netRestaurantRevenue: net("RESTAURANT_REVENUE_PAYABLE").toString(),
      netTip: net("TIP_PAYABLE").toString(),
      netPlatformFee: net("PLATFORM_FEE_REVENUE").toString(),
      tax: net("TAX_PAYABLE").toString(),
      processingFee: null,
      refundedAmount: net("REFUND_CONTRA").toString(),
    };
  }

  /** API_Contract.md, Transaction List — reachability-scoped the same way Payment History
   * already is (ADR-005), narrowed further by restaurantId/status/membership. */
  async findAllForUser(
    user: AuthenticatedUser,
    filters: TransactionListQueryDto,
  ): Promise<TransactionListPage> {
    const where = this.buildWhere(user, filters);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.transaction.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
      this.prisma.transaction.count({ where }),
    ]);

    const tips = await this.netTipsByTransaction(rows.map((t) => t.id));

    return {
      data: rows.map((t) => this.toListEntry(t, tips.get(t.id) ?? 0n)),
      meta: {
        page: filters.page,
        limit: filters.limit,
        total,
        pages: Math.ceil(total / filters.limit),
      },
    };
  }

  /** API_Contract.md, Export — same filters as Transaction List, no pagination, every matching
   * row. `processingFee` deliberately omitted from the CSV entirely (ADR-025): no CSV convention
   * distinguishes "unavailable" from "zero" the way JSON `null` does. */
  async exportCsv(user: AuthenticatedUser, filters: TransactionExportQueryDto): Promise<string> {
    const where = this.buildWhere(user, filters);
    const rows = await this.prisma.transaction.findMany({ where, orderBy: { createdAt: "desc" } });

    const header =
      "id,restaurantId,grossAmount,currency,status,createdAt,netRestaurantRevenue,netTip,netPlatformFee,tax,refundedAmount";
    const lines = await Promise.all(
      rows.map(async (t) => {
        const b = await this.computeBreakdown(t.id);
        return [
          t.id,
          t.restaurantId,
          t.grossAmount.toString(),
          t.currency,
          t.status,
          t.createdAt.toISOString(),
          b.netRestaurantRevenue,
          b.netTip,
          b.netPlatformFee,
          b.tax,
          b.refundedAmount,
        ].join(",");
      }),
    );

    return [header, ...lines].join("\n");
  }

  /**
   * ADR-043. Scoped by the Memberships that actually carry , not by every
   * Membership the caller holds. The earlier version filtered by reachability alone, which let a
   * permission held in one Organization widen a list built from a Membership in another — proved
   * by , which exported another restaurant's rows as a Waiter.
   */
  /**
   * ADR-043. Scoped by the Memberships that actually carry `reports.view`, never by every
   * Membership the caller holds.
   *
   * The earlier version filtered on reachability alone, which let a permission held in one
   * Organization widen a list built from a Membership in another. Not an argument — measured:
   * `permission-scope.e2e.spec.ts` exported another restaurant's transaction rows, amounts
   * included, as a zero-permission Waiter.
   */
  private buildWhere(
    user: AuthenticatedUser,
    filters: TransactionListQueryDto | TransactionExportQueryDto,
  ) {
    const { organizationIds, restaurantIds } = permittedScope(user, TRANSACTION_PERMISSION);

    const reachableWhere = {
      OR: [
        { restaurant: { organizationId: { in: organizationIds } } },
        { restaurantId: { in: restaurantIds } },
      ],
    };

    return {
      AND: [
        reachableWhere,
        filters.restaurantId ? { restaurantId: filters.restaurantId } : {},
        filters.status ? { status: filters.status } : {},
        filters.membership ? { payment: { waiterMembershipId: filters.membership } } : {},
      ],
    };
  }

  /** `net(TIP_PAYABLE)` per Transaction for a whole page, in ONE groupBy.
   *
   * **Deliberately not a per-row `computeBreakdown` call**: that is the N+1 this screen would
   * otherwise ship with, and UX_API_RECONCILIATION asked for the call count to be a decision
   * rather than an accident. One extra query per page, whatever the page size. */
  private async netTipsByTransaction(transactionIds: string[]): Promise<Map<string, bigint>> {
    if (transactionIds.length === 0) return new Map();

    const groups = await this.prisma.ledgerLine.groupBy({
      by: ["journalEntryId", "direction"],
      where: {
        account: "TIP_PAYABLE",
        journalEntry: { transactionId: { in: transactionIds } },
      },
      _sum: { amount: true },
    });

    // groupBy cannot group by a relation's column, so the entry -> transaction mapping is read
    // back separately and folded in. Two queries, still not per row.
    const entries = await this.prisma.journalEntry.findMany({
      where: { transactionId: { in: transactionIds } },
      select: { id: true, transactionId: true },
    });
    const entryToTransaction = new Map(entries.map((e) => [e.id, e.transactionId]));

    const net = new Map<string, bigint>();
    for (const g of groups) {
      const transactionId = entryToTransaction.get(g.journalEntryId);
      if (!transactionId) continue;
      const delta = (g._sum.amount ?? 0n) * (g.direction === "CREDIT" ? 1n : -1n);
      net.set(transactionId, (net.get(transactionId) ?? 0n) + delta);
    }
    return net;
  }

  private toListEntry(t: Transaction, tip: bigint): TransactionListEntry {
    return {
      id: t.id,
      restaurantId: t.restaurantId,
      paymentId: t.paymentId,
      grossAmount: t.grossAmount.toString(),
      currency: t.currency,
      tip: tip.toString(),
      status: t.status,
      createdAt: t.createdAt,
    };
  }

  /**
   * Scope check for a single Transaction read by id (`GET /transactions/{id}`).
   *
   * **Reachability alone used to be the whole rule, and it leaked.** Measured, not inferred
   * (PR #108): a zero-permission Waiter at this Restaurant received gross, net revenue, net tip,
   * net platform fee, tax, refunds and chargebacks. `isRestaurantReachable` is satisfied by *any*
   * Membership, and this route carried no `@RequirePermission` above it.
   *
   * Now `hasPermissionAtRestaurant`, which is the same predicate `permittedScope` filters
   * `buildWhere` with — asked about one known row rather than used to build a query. The list and
   * the by-id read now answer the same question the same way; ADR-043 closed the list and this
   * route was simply never part of it.
   */
  private async assertPermittedAtRestaurant(
    restaurantId: string,
    user: AuthenticatedUser,
  ): Promise<void> {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { id: restaurantId, deletedAt: null },
      select: { id: true, organizationId: true },
    });
    if (!restaurant) {
      throw new AppException("RESTAURANT_NOT_FOUND", "Restaurant not found.", 404);
    }
    if (!hasPermissionAtRestaurant(user, restaurant, TRANSACTION_PERMISSION)) {
      // 404 rather than 403: confirming a transaction exists at a restaurant the caller cannot
      // read is itself the disclosure. Same answer the list gives by omitting the row.
      throw new AppException("NOT_FOUND", "Transaction not found.", 404);
    }
  }
}
