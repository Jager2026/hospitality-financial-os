import type { JournalEntryType, LedgerAccount, LedgerDirection } from "@prisma/client";

/** One LedgerLine to be written as part of a JournalEntry. Mirrors DATABASE.md's LedgerLine
 * entity exactly — `restaurantId`/`membershipId` are set only on lines that credit or debit a
 * specific Restaurant's or Membership's balance (ADR-002). */
export interface LedgerLineInput {
  account: LedgerAccount;
  direction: LedgerDirection;
  amount: bigint; // minor units (ADR-001) — never a float
  currency: string; // ISO 4217 code, references Currency.code
  restaurantId?: string;
  membershipId?: string;
}

/** One balanced financial event (ADR-002). At most one of refundId/chargebackId/adjustmentId
 * may be set, and it must agree with entryType — enforced both here (fail fast, in-process) and
 * by the database CHECK constraint (prisma/sql/ledger_integrity.sql) as defense in depth. */
export interface PostJournalEntryInput {
  entryType: JournalEntryType;
  transactionId?: string;
  refundId?: string;
  chargebackId?: string;
  adjustmentId?: string;
  description?: string;
  lines: LedgerLineInput[];
}
