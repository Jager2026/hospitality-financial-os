-- ADR-096 — the shift close stops depending on Stripe being reachable.
--
-- `available_on` arrives inside the very BalanceTransaction ADR-094 already fetches for the
-- processing fee, and was read and discarded. Keeping it costs no extra call to Stripe.
--
-- The reason is not the call count. Without this column, answering "when does this money arrive"
-- at shift close requires a live round trip per transaction — so a venue's own figure would fail
-- for a reason having nothing to do with that venue. A closing till must not depend on a third
-- party's uptime.
--
-- Written by the SAME conditional update that claims the fee, so the date and the fee cannot
-- disagree about which delivery produced them (the claim idiom, CLAUDE_RULES.md).
--
-- NULL means the fee has not been fetched yet, or never will be — the two are told apart by the
-- Outbox row, not by this column (ADR-094's three states).

ALTER TABLE "transaction" ADD COLUMN "funds_available_on" TIMESTAMP(3);
