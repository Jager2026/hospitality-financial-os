-- ============================================================================
-- ADR-069: the audit record for one outbound email.
--
-- Sending an invitation is a DISCLOSURE EVENT — a token granting access to an Organization leaves
-- the system — so the record is written before the send is attempted, in the same transaction as
-- the OutboxEvent that requests it. "We decided to send" and "there is a record of the send" are
-- then one fact rather than two that can disagree.
--
-- The UNIQUE index on outbox_event_id is the load-bearing line, not bookkeeping.
-- OutboxPollerService has no claim step (IMPLEMENTATION_PLAN.md, Deferred): two backend instances
-- both dispatch the same row, and that file's own comment names email as the case where a double
-- dispatch becomes a double effect. This constraint makes the second attempt fail against the
-- database instead of against the recipient's inbox.
--
-- The email BODY is deliberately absent. It carries the invitation token, which ADR-020 keeps
-- unpersisted on purpose; storing the rendered body here would silently undo that.
--
-- Generated with `prisma migrate diff --from-schema-datasource --to-schema-datamodel --script`
-- (`migrate dev` refuses a non-interactive shell), then hand-annotated.
-- ============================================================================

-- CreateEnum
CREATE TYPE "email_delivery_status" AS ENUM ('pending', 'sent', 'failed');

-- CreateTable
CREATE TABLE "email_delivery" (
    "id" UUID NOT NULL,
    "outbox_event_id" UUID NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "status" "email_delivery_status" NOT NULL DEFAULT 'pending',
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_delivery_outbox_event_id_key" ON "email_delivery"("outbox_event_id");

-- CreateIndex
CREATE INDEX "email_delivery_status_idx" ON "email_delivery"("status");

