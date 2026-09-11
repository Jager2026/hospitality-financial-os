-- ADR-083. The outbox poller gains a backoff, and a backoff needs somewhere to remember when the
-- next attempt is due.
--
-- `DEFAULT CURRENT_TIMESTAMP` is what makes this safe to apply to a table that already has rows:
-- every existing unpublished event becomes eligible immediately, which is exactly the behaviour it
-- had before this column existed. Backfilling to a future time would silently pause a queue that
-- may be holding money projections, and backfilling to NULL would need a nullable column and a
-- three-state query for no gain.
--
-- Written add-column-with-default rather than add-nullable-then-backfill because the default is
-- correct for every existing row; there is no row for which "eligible now" is the wrong answer.
ALTER TABLE "outbox_event" ADD COLUMN "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- The poller filters on `published_at IS NULL AND next_attempt_at <= now()`. A composite index has
-- `published_at` as its prefix, so it answers the old single-column queries too and the old index
-- becomes redundant storage and write cost rather than a second useful path.
DROP INDEX "outbox_event_published_at_idx";

CREATE INDEX "outbox_event_published_at_next_attempt_at_idx" ON "outbox_event"("published_at", "next_attempt_at");
