-- ============================================================================
-- ADR-064: the Shift — a restaurant's own working day, which is not the calendar day.
--
-- The venue closes its day with a Z-report, usually before midnight and regularly after it. A
-- payment at 01:30 on a shift nobody has closed belongs to that shift. Counting it as the next
-- day's is what a calendar-only model does, and it reproduces exactly the discrepancy between
-- "the system's today" and "the Z-report" this product exists to remove.
--
-- Two labels, both kept: ledger_line.created_at stays the calendar instant (accounting and tax
-- are calendar-bound), ledger_line.shift_id is the operational one. Neither is derivable from
-- the other.
--
-- Generated with `prisma migrate diff --from-schema-datasource --to-schema-datamodel --script`
-- (`migrate dev` refuses a non-interactive shell), then hand-annotated and extended with the two
-- constraints Prisma's schema language cannot express.
-- ============================================================================

-- CreateEnum
CREATE TYPE "shift_close_reason" AS ENUM ('button', 'scheduled');

-- AlterTable
ALTER TABLE "ledger_line" ADD COLUMN     "shift_id" UUID;

-- AlterTable
ALTER TABLE "restaurant" ADD COLUMN     "shift_auto_close_minutes" INTEGER NOT NULL DEFAULT 300;

-- CreateTable
CREATE TABLE "shift" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),
    "close_reason" "shift_close_reason",
    "closed_by" UUID,
    "business_date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shift_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shift_restaurant_id_business_date_idx" ON "shift"("restaurant_id", "business_date");

-- CreateIndex
CREATE INDEX "shift_restaurant_id_closed_at_idx" ON "shift"("restaurant_id", "closed_at");

-- CreateIndex
CREATE INDEX "ledger_line_shift_id_idx" ON "ledger_line"("shift_id");

-- AddForeignKey
ALTER TABLE "ledger_line" ADD CONSTRAINT "ledger_line_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift" ADD CONSTRAINT "shift_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift" ADD CONSTRAINT "shift_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- One open Shift per Restaurant, enforced by the database rather than by the service.
--
-- `resolveOpenShift` reads-then-creates inside the posting transaction. Two concurrent captures
-- at a venue with no open shift would both read "none" and both insert — the same
-- non-atomic-upsert race `global-setup.ts` already documents for Currency/Role seeding, which was
-- real and not hypothetical. A partial unique index makes the second insert fail rather than
-- silently produce two open shifts and split one evening's takings between them.
--
-- Partial, because only OPEN shifts are constrained: a restaurant has any number of closed ones.
-- Prisma cannot express a WHERE on a unique index, so it lives here.
-- ============================================================================
CREATE UNIQUE INDEX "shift_one_open_per_restaurant"
  ON "shift" ("restaurant_id")
  WHERE "closed_at" IS NULL;

-- ============================================================================
-- A closed Shift must say HOW it closed, and an open one must not claim to have closed.
--
-- Same single-row CHECK discipline as agreement_acceptance_subject_matches_type (ADR-049) and
-- journal_entry_compensating_fk_matches_type (ADR-017): two nullable columns with a rule about
-- when each applies is a convention until the database enforces it. Without this, one bad write
-- produces a shift that is closed with no reason, and every report that groups by close_reason
-- silently loses it.
--
-- closed_by is NOT constrained here: a SCHEDULED close legitimately has no actor, and a BUTTON
-- close made by a since-deleted User has closed_by set to NULL by the FK above. Requiring an
-- actor for BUTTON would turn a user deletion into a constraint violation on historical rows.
-- ============================================================================
ALTER TABLE "shift"
  ADD CONSTRAINT "shift_close_reason_matches_state"
  CHECK (
    ("closed_at" IS NULL AND "close_reason" IS NULL)
    OR ("closed_at" IS NOT NULL AND "close_reason" IS NOT NULL)
  );

-- The auto-close setting is a minute of the local day: 0..1439. A value outside that range is not
-- a late close, it is a shift that never closes automatically — the safety net silently absent,
-- which is the failure this column exists to prevent.
ALTER TABLE "restaurant"
  ADD CONSTRAINT "restaurant_shift_auto_close_minutes_in_day"
  CHECK ("shift_auto_close_minutes" >= 0 AND "shift_auto_close_minutes" < 1440);
