-- ADR-094 — the processor's fee enters the books.
--
-- Three additions, and each is a different kind of thing:
--
--  1. `journal_entry_type.processor_fee` — a SECOND entry, never a correction of the capture.
--     Stripe publishes the fee on a BalanceTransaction that is not populated at the moment the
--     charge succeeds (measured: null on a retrieve immediately after confirmation, present
--     seconds later, ADR-093), so the amount cannot be part of PAYMENT_CAPTURED. ADR-002 forbids
--     editing a posted entry; ADR-090's dispute reversal is the same shape.
--
--  2. `ledger_account.processor_fee` — where that amount lands. ADR-092 established that with
--     direct charges Stripe debits the CONNECTED account's balance, so this is the venue's cost
--     passing through our books rather than the platform's expense. Its class in the chart of
--     accounts is the rename OC-15 holds open and is deliberately NOT decided here.
--
--  3. `transaction.processor_fee_balance_txn_id` — the CLAIM, not a cache. The fee entry is
--     posted only by the delivery whose conditional UPDATE moves this column off NULL, which is
--     what makes a redelivered event debit the Ledger once. The balance trigger sums an entry's
--     own lines and has no opinion about whether another entry describes the same fee (ADR-089),
--     so idempotency has to come from a claim. UNIQUE because it is an identifier issued by
--     Stripe naming exactly one object (OC-13's rule); NULL means "not posted yet" and many rows
--     are NULL at once, which a plain unique index allows.

ALTER TYPE "journal_entry_type" ADD VALUE IF NOT EXISTS 'processor_fee';
ALTER TYPE "ledger_account" ADD VALUE IF NOT EXISTS 'processor_fee';

ALTER TABLE "transaction" ADD COLUMN "processor_fee_balance_txn_id" TEXT;

CREATE UNIQUE INDEX "transaction_processor_fee_balance_txn_id_key"
  ON "transaction" ("processor_fee_balance_txn_id");
