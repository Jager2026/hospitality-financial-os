import { Injectable } from "@nestjs/common";
import type { LedgerAccount } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  processorFeeStatuses,
  type ProcessorFeeStatus,
} from "../processor-fee/processor-fee-status.util";

/**
 * ADR-096 — what a shift close answers.
 *
 * **The question is one question**: how much did this shift earn, and when does it arrive. Every
 * field here exists to answer it or to say honestly that part of it is not answerable yet.
 */

/** ADR-094's three states, carried on every amount that depends on Stripe. */
export type AmountState = ProcessorFeeStatus;

export interface StatedAmount {
  /** Minor units (ADR-001). **`null` when the amount is not known — never `0`.** */
  amount: string | null;
  state: AmountState;
}

export interface DeductionRow {
  /** Stable machine key. A fourth deduction is a fourth row, never a fourth top-level field. */
  kind: "stripe_processing" | "platform_fee";
  amount: string | null;
  state: AmountState;
}

export interface AvailabilityRow {
  /** Midnight UTC, as Stripe stated it. */
  availableOn: string;
  /** What lands on that date: the charge amount less Stripe's own fee. */
  amount: string;
  transactions: number;
}

export interface ShiftCloseSummary {
  shiftId: string;
  restaurantId: string;
  businessDate: string;
  openedAt: Date;
  closedAt: Date | null;
  currency: string;
  transactions: number;
  /** The bill, before any deduction. Ours to compute, so always known. */
  grossRevenue: StatedAmount;
  /** Separate from revenue on purpose: a tip is the staff's, not the venue's (ADR-053). */
  tips: StatedAmount;
  deductions: DeductionRow[];
  /** Gross less every deduction. Tips are not subtracted here — they were never revenue. */
  netToVenue: StatedAmount;
  /** **Always a list, even when it holds one row.** */
  availability: {
    rows: AvailabilityRow[];
    /** Transactions whose date is not known yet, or never will be. */
    unresolved: number;
    state: AmountState;
  };
}

const BILL_ACCOUNTS: LedgerAccount[] = ["RESTAURANT_REVENUE_PAYABLE", "PLATFORM_FEE_REVENUE"];

/** The worst of the three, because a total is only as known as its least-known part. */
function combine(states: AmountState[]): AmountState {
  if (states.includes("pending")) return "pending";
  if (states.includes("unavailable")) return "unavailable";
  return "available";
}

@Injectable()
export class ShiftCloseSummaryService {
  constructor(private readonly prisma: PrismaService) {}

  async summarise(shiftId: string): Promise<ShiftCloseSummary> {
    const shift = await this.prisma.shift.findUniqueOrThrow({
      where: { id: shiftId },
      include: { restaurant: { select: { currency: true } } },
    });

    // ADR-064: a LedgerLine carries the Shift it was posted in, so the shift's money is found by
    // the label rather than by a time window — which is the whole reason that label exists.
    const lines = await this.prisma.ledgerLine.findMany({
      where: { shiftId },
      select: {
        account: true,
        direction: true,
        amount: true,
        journalEntry: { select: { transactionId: true } },
      },
    });

    const net = (accounts: LedgerAccount[]): bigint => {
      let total = 0n;
      for (const l of lines) {
        if (!accounts.includes(l.account)) continue;
        total += l.direction === "CREDIT" ? l.amount : -l.amount;
      }
      return total;
    };

    const transactionIds = [
      ...new Set(lines.map((l) => l.journalEntry.transactionId).filter((id): id is string => !!id)),
    ];
    const transactions = await this.prisma.transaction.findMany({
      where: { id: { in: transactionIds } },
      select: {
        id: true,
        paymentId: true,
        grossAmount: true,
        processorFeeBalanceTxnId: true,
        fundsAvailableOn: true,
        payment: { select: { tipAmount: true } },
      },
    });

    // One query for every transaction's fee state rather than one query each: a shift with fifty
    // payments would otherwise open fifty round trips at exactly the moment somebody is waiting.
    const states = await processorFeeStatuses(this.prisma, transactions);

    const grossRevenue = net(BILL_ACCOUNTS); // ADR-026's own definition: the bill before our fee
    const platformFee = net(["PLATFORM_FEE_REVENUE"]);
    const tips = transactions.reduce((sum, t) => sum + t.payment.tipAmount, 0n);

    // Stripe's REAL fee, taken from the Ledger where ADR-094 posted it — `amount − net` as Stripe
    // computed it, never a rate of ours applied to an amount of ours.
    const stripeFee = -net(["PROCESSOR_FEE"]); // a debit nets negative; the deduction is its size
    const feeStates = transactions.map((t) => states.get(t.id) ?? "unavailable");
    const stripeFeeState = combine(feeStates);

    // Stripe takes its fee per charge, so what lands on a given date is per charge too.
    const feeByTransaction = new Map<string, bigint>();
    for (const l of lines) {
      if (l.account !== "PROCESSOR_FEE") continue;
      const id = l.journalEntry.transactionId;
      if (!id) continue;
      const signed = l.direction === "DEBIT" ? l.amount : -l.amount;
      feeByTransaction.set(id, (feeByTransaction.get(id) ?? 0n) + signed);
    }

    const availability = this.groupByAvailableOn(transactions, states, feeByTransaction);

    const netToVenue =
      stripeFeeState === "available" ? grossRevenue - platformFee - stripeFee : null;

    return {
      shiftId: shift.id,
      restaurantId: shift.restaurantId,
      businessDate: shift.businessDate.toISOString().slice(0, 10),
      openedAt: shift.openedAt,
      closedAt: shift.closedAt,
      currency: shift.restaurant.currency,
      transactions: transactions.length,
      grossRevenue: { amount: grossRevenue.toString(), state: "available" },
      tips: { amount: tips.toString(), state: "available" },
      deductions: [
        {
          kind: "stripe_processing",
          amount: stripeFeeState === "available" ? stripeFee.toString() : null,
          state: stripeFeeState,
        },
        { kind: "platform_fee", amount: platformFee.toString(), state: "available" },
      ],
      netToVenue: {
        amount: netToVenue === null ? null : netToVenue.toString(),
        state: stripeFeeState,
      },
      availability,
    };
  }

  /**
   * **A list, and it is a list for a measured reason.** `available_on` is midnight UTC of the
   * charge's UTC date plus the account's delay, and UTC midnight falls at 03:00 Vilnius in summer
   * and 02:00 in winter — so a venue trading past those hours splits one shift across two dates.
   * Collapsing them into one number would state a date the money does not arrive on.
   */
  private groupByAvailableOn(
    transactions: Array<{
      id: string;
      grossAmount: bigint;
      fundsAvailableOn: Date | null;
      processorFeeBalanceTxnId: string | null;
    }>,
    states: Map<string, AmountState>,
    feeByTransaction: Map<string, bigint>,
  ): ShiftCloseSummary["availability"] {
    const byDate = new Map<string, { amount: bigint; transactions: number }>();
    let unresolved = 0;
    const seen: AmountState[] = [];

    for (const t of transactions) {
      const state = states.get(t.id) ?? "unavailable";
      seen.push(state);
      if (t.fundsAvailableOn === null) {
        unresolved += 1;
        continue;
      }
      const key = t.fundsAvailableOn.toISOString();
      const prev = byDate.get(key) ?? { amount: 0n, transactions: 0 };
      // What actually lands is the charge less Stripe's own fee. Our platform fee leaves the
      // venue's balance as its own movement (ADR-092), so it is not subtracted here.
      const landed = t.grossAmount - (feeByTransaction.get(t.id) ?? 0n);
      byDate.set(key, { amount: prev.amount + landed, transactions: prev.transactions + 1 });
    }

    return {
      rows: [...byDate]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([availableOn, agg]) => ({
          availableOn,
          amount: agg.amount.toString(),
          transactions: agg.transactions,
        })),
      unresolved,
      state: combine(seen),
    };
  }
}
