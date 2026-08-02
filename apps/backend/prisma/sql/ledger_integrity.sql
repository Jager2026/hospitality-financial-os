-- Ledger integrity constraints — not expressible in schema.prisma's DSL, so hand-authored here.
--
-- HOW TO APPLY (cannot be run from this session — no Node.js/Prisma CLI in this sandbox):
--   1. pnpm install
--   2. pnpm --filter backend exec prisma migrate dev --name init
--      (generates the baseline migration from schema.prisma against your local Postgres)
--   3. pnpm --filter backend exec prisma migrate dev --create-only --name ledger_integrity_constraints
--      (creates an empty migration file under apps/backend/prisma/migrations/)
--   4. Paste the entire contents of this file into that generated migration.sql
--   5. pnpm --filter backend exec prisma migrate dev
--      (applies it)
-- Do not skip step 2 — everything below assumes the tables from schema.prisma already exist.

-- ============================================================================
-- 1. journal_entry: entry_type must match which compensating FK is set
--    (ADR-017 follow-on, Founder-requested — Sprint 0 audit revision)
-- ============================================================================
-- Single-row constraint — no deferral needed, unlike the trigger below.

ALTER TABLE journal_entry
  ADD CONSTRAINT journal_entry_compensating_fk_matches_type
  CHECK (
    (entry_type = 'refund_issued'
      AND refund_id IS NOT NULL AND chargeback_id IS NULL AND adjustment_id IS NULL)
    OR (entry_type = 'chargeback'
      AND chargeback_id IS NOT NULL AND refund_id IS NULL AND adjustment_id IS NULL)
    OR (entry_type = 'adjustment'
      AND adjustment_id IS NOT NULL AND refund_id IS NULL AND chargeback_id IS NULL)
    OR (entry_type IN ('payment_captured', 'tip_allocated', 'payout')
      AND refund_id IS NULL AND chargeback_id IS NULL AND adjustment_id IS NULL)
  );

-- ============================================================================
-- 2. ledger_line: debits must equal credits per journal_entry_id (ADR-002)
--    Defense-in-depth behind the Ledger Module write-helper — Sprint 0 audit §2,
--    Founder-approved.
-- ============================================================================
-- Deferred is essential: a non-deferred trigger would reject the first LedgerLine of every
-- multi-line JournalEntry before its balancing line(s) exist in the same transaction. A deferred
-- constraint trigger instead runs once at COMMIT, after every line in the transaction has been
-- written.
--
-- LIMITATION: this only re-checks the journal_entry_id of the row that was actually touched
-- (NEW on INSERT/UPDATE, OLD on DELETE). If a line were ever moved between JournalEntries via
-- UPDATE ledger_line SET journal_entry_id = ... — which should never happen; LedgerLine is
-- immutable by DATABASE.md's own rule — only the *new* owning entry gets re-validated in that
-- statement. The entry that lost the line is not automatically re-checked unless something else
-- in the same transaction also touches one of its other lines. Not a gap worth closing today
-- (the immutability rule already forbids the scenario that would trigger it), but worth knowing
-- this trigger is not an unconditional guarantee against every possible write pattern.

CREATE OR REPLACE FUNCTION check_journal_entry_balanced() RETURNS trigger AS $$
DECLARE
  affected_entry_id uuid;
  debit_total bigint;
  credit_total bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    affected_entry_id := OLD.journal_entry_id;
  ELSE
    affected_entry_id := NEW.journal_entry_id;
  END IF;

  SELECT
    COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0),
    COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)
  INTO debit_total, credit_total
  FROM ledger_line
  WHERE journal_entry_id = affected_entry_id;

  IF debit_total <> credit_total THEN
    RAISE EXCEPTION 'JournalEntry % is unbalanced: debits=% credits=%',
      affected_entry_id, debit_total, credit_total;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_line_balanced
  AFTER INSERT OR UPDATE OR DELETE ON ledger_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION check_journal_entry_balanced();
