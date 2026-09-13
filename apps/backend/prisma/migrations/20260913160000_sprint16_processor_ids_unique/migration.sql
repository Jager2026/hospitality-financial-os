-- ============================================================================
-- ADR-089. An identifier issued by Stripe names one thing. Three indexes say so.
--
-- ADR-088's measurement found the pattern: wherever a natural key is a foreign key to one of our
-- own tables it is constrained, and wherever it is an identifier issued by Stripe it is not. These
-- are the three.
--
-- NULL SEMANTICS, decided per column and not inherited from ADR-088: all three are **NOT NULL** in
-- the schema — confirmed against `information_schema`, not read off the model — so there is no NULL
-- to be distinct or not distinct about. `NULLS NOT DISTINCT` is inapplicable here rather than
-- declined, which is a different statement and the reason it is written down.
--
-- NOT PARTIAL, and this is also a per-column decision. ADR-088's index is partial because a
-- membership is deactivated and the row stays, so the same person may hold the scope again. Nothing
-- of that shape applies to a processor id: a Stripe PaymentIntent, refund or dispute identifier
-- names exactly one object for as long as it exists, in any status. There is no second legitimate
-- row to make room for.
--
-- Safe to apply: zero duplicate groups in all three columns, measured immediately before writing
-- this (payment 3,112 rows, refund 270, chargeback 150). CI creates its Postgres container per run,
-- so it starts empty by construction.
-- ============================================================================

-- `payment.processor_payment_id` — an ASSERTION, not a fix, and it is labelled that way honestly.
-- No path was found that produces a duplicate: `POST /payments` sits behind IdempotencyInterceptor
-- and `payment.idempotency_key` is unique, and `StripeService.createPaymentIntent` passes NO
-- idempotency key to Stripe, so every call yields a fresh intent id. What this buys is that
-- `findFirst({ where: { processorPaymentId } })` — which appears in the capture path and in
-- reconciliation, and silently picks one row of N — stops being an assumption.
CREATE UNIQUE INDEX "payment_processor_payment_id_key"
  ON "payment" ("processor_payment_id");

-- `refund.processor_refund_id` — also an assertion. Reproduced against the real database: a
-- `charge.refunded` redelivered under a DIFFERENT event id inserts nothing, stopped by the
-- handler's own `return; // nothing new — a duplicate or out-of-order delivery`, which compares the
-- cumulative refunded amount against what the Ledger already reversed. That guard is correct and it
-- is a rule in one code path.
CREATE UNIQUE INDEX "refund_processor_refund_id_key"
  ON "refund" ("processor_refund_id");

-- `chargeback.processor_dispute_id` — A FIX. This one is not an assertion, and the difference was
-- established by execution rather than by reading the other two and assuming.
--
-- Measured: one `charge.dispute.created` delivered twice under two different event ids produced
-- **two Chargeback rows and two CHARGEBACK journal entries** — the same dispute debited twice. The
-- event-id claim does not catch it, because the ids differ; the refund path's cumulative guard has
-- no counterpart here; and the balance trigger is silent, because it checks that each entry
-- balances and knows nothing about whether another entry describes the same dispute.
--
-- Reconciliation does not catch it either, and not merely late: it selects `status = PENDING`, and
-- a disputed payment is SUCCEEDED. It never looks.
--
-- After this index the second delivery FAILS instead of duplicating, which is better and is not the
-- whole answer: `handleEvent` rethrows, so Stripe sees an error and retries forever. Teaching the
-- handler to recognise a dispute it already has is webhook-deduplication semantics and has its own
-- change.
CREATE UNIQUE INDEX "chargeback_processor_dispute_id_key"
  ON "chargeback" ("processor_dispute_id");
