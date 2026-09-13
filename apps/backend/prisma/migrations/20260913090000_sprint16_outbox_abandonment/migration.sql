-- ADR-085. The queue gains a second exit.
--
-- Until now an OutboxEvent could leave the poller's query in exactly one way: by being published.
-- A row that can never be published — a payload referring to no JournalEntry at all — therefore
-- occupied a slot in the oldest-first batch of 50 forever. These two columns are the terminal
-- state that was missing, and the reason it is a state rather than a DELETE: an event this system
-- gave up on is evidence, and deleting it destroys the only record that it ever existed.
--
-- NULL for every existing row, and that is the correct backfill rather than a convenient one:
-- nothing has been abandoned yet, and inferring abandonment from the shape of a stored payload
-- would be this migration deciding something the poller is supposed to decide at dispatch time,
-- with the handler's own reason attached. The rows that qualify are abandoned on the first poll
-- after deploy, each with its own explanation.
ALTER TABLE "outbox_event" ADD COLUMN "abandoned_at" TIMESTAMP(3);
ALTER TABLE "outbox_event" ADD COLUMN "abandoned_reason" TEXT;

-- The poller now filters on `published_at IS NULL AND abandoned_at IS NULL AND (attempts = 0 OR
-- next_attempt_at <= now())`. `published_at` stays the prefix, so this composite answers every
-- query the previous one did and replaces it rather than joining it — the same reasoning, and the
-- same replacement, as ADR-083's own migration.
DROP INDEX "outbox_event_published_at_next_attempt_at_idx";

CREATE INDEX "outbox_event_published_at_abandoned_at_next_attempt_at_idx"
  ON "outbox_event"("published_at", "abandoned_at", "next_attempt_at");
