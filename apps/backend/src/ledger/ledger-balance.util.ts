import type { LedgerLineInput, PostJournalEntryInput } from "./ledger.types";

const COMPENSATING_ENTITY_BY_TYPE: Record<
  string,
  "refundId" | "chargebackId" | "adjustmentId" | null
> = {
  PAYMENT_CAPTURED: null,
  TIP_ALLOCATED: null,
  PAYOUT: null,
  REFUND_ISSUED: "refundId",
  CHARGEBACK: "chargebackId",
  ADJUSTMENT: "adjustmentId",
};

export class LedgerUnbalancedError extends Error {
  constructor(currency: string, debitTotal: bigint, creditTotal: bigint) {
    super(
      `JournalEntry is unbalanced for currency ${currency}: debits=${debitTotal} credits=${creditTotal}`,
    );
    this.name = "LedgerUnbalancedError";
  }
}

export class LedgerEmptyPostingError extends Error {
  constructor() {
    super(
      "A JournalEntry must have at least one LedgerLine — an empty posting has no event to record.",
    );
    this.name = "LedgerEmptyPostingError";
  }
}

export class LedgerCompensatingEntityMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerCompensatingEntityMismatchError";
  }
}

/**
 * The primary enforcement layer for ADR-002's debit=credit invariant (Sprint 0 audit §2, Layer
 * 1) — runs synchronously, before any database write, so an unbalanced posting never reaches the
 * Ledger Module's transaction at all. The deferred Postgres trigger
 * (prisma/sql/ledger_integrity.sql) is Layer 2, defense in depth in case this is ever bypassed.
 *
 * Rejects an empty posting outright — zero lines "balances" trivially (0=0) but represents no
 * actual financial event, which is meaningless for a JournalEntry.
 *
 * Lines are grouped by currency: DATABASE.md doesn't state that a single JournalEntry must be
 * single-currency, so each currency present must balance independently rather than assuming only
 * one currency ever appears.
 */
export function assertBalanced(lines: LedgerLineInput[]): void {
  if (lines.length === 0) {
    throw new LedgerEmptyPostingError();
  }

  const totals = new Map<string, { debit: bigint; credit: bigint }>();

  for (const line of lines) {
    const entry = totals.get(line.currency) ?? { debit: 0n, credit: 0n };
    if (line.direction === "DEBIT") {
      entry.debit += line.amount;
    } else {
      entry.credit += line.amount;
    }
    totals.set(line.currency, entry);
  }

  for (const [currency, { debit, credit }] of totals) {
    if (debit !== credit) {
      throw new LedgerUnbalancedError(currency, debit, credit);
    }
  }
}

/**
 * Application-layer mirror of the entry_type CHECK constraint (ADR-017 follow-on,
 * prisma/sql/ledger_integrity.sql) — fails fast in-process rather than only at the database.
 */
export function assertCompensatingEntityMatchesType(input: PostJournalEntryInput): void {
  const requiredField = COMPENSATING_ENTITY_BY_TYPE[input.entryType];
  const provided = {
    refundId: input.refundId,
    chargebackId: input.chargebackId,
    adjustmentId: input.adjustmentId,
  };
  const setFields = (Object.keys(provided) as Array<keyof typeof provided>).filter(
    (field) => provided[field] !== undefined,
  );

  if (requiredField === null) {
    if (setFields.length > 0) {
      throw new LedgerCompensatingEntityMismatchError(
        `entryType ${input.entryType} must not set any of refundId/chargebackId/adjustmentId, got: ${setFields.join(", ")}`,
      );
    }
    return;
  }

  if (setFields.length !== 1 || setFields[0] !== requiredField) {
    throw new LedgerCompensatingEntityMismatchError(
      `entryType ${input.entryType} requires exactly ${requiredField} to be set and no other compensating id, got: ${setFields.join(", ") || "none"}`,
    );
  }
}
