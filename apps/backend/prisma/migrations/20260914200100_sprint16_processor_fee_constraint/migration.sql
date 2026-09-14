-- ADR-094, second half. Teaching the compensating-FK CHECK about the new entry type.
--
-- SEPARATE from the migration that adds the enum value, and not for tidiness: Postgres refuses
-- "unsafe use of new value of enum type" when a statement uses a label added by an earlier
-- statement of the SAME transaction, and Prisma runs each migration file in one transaction. The
-- split is the requirement, not a preference.
--
-- PROCESSOR_FEE joins the group that sets no compensating FK at all. It is attached to a
-- Transaction like PAYMENT_CAPTURED is, and it has no Refund/Chargeback/Adjustment behind it —
-- the thing it compensates for is the processor's own deduction, which this system does not model
-- as an entity and has no reason to.

ALTER TABLE journal_entry
  DROP CONSTRAINT journal_entry_compensating_fk_matches_type;

ALTER TABLE journal_entry
  ADD CONSTRAINT journal_entry_compensating_fk_matches_type
  CHECK (
    (entry_type = 'refund_issued'
      AND refund_id IS NOT NULL AND chargeback_id IS NULL AND adjustment_id IS NULL)
    OR (entry_type = 'chargeback'
      AND chargeback_id IS NOT NULL AND refund_id IS NULL AND adjustment_id IS NULL)
    OR (entry_type = 'adjustment'
      AND adjustment_id IS NOT NULL AND refund_id IS NULL AND chargeback_id IS NULL)
    OR (entry_type IN ('payment_captured', 'tip_allocated', 'payout', 'processor_fee')
      AND refund_id IS NULL AND chargeback_id IS NULL AND adjustment_id IS NULL)
  );
