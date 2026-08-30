-- CreateEnum
CREATE TYPE "agreement_type" AS ENUM ('platform_terms', 'stripe_connected_account');

-- CreateTable
CREATE TABLE "agreement_acceptance" (
    "id" UUID NOT NULL,
    "agreement" "agreement_type" NOT NULL,
    "version" TEXT NOT NULL,
    "user_id" UUID,
    "restaurant_id" UUID,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_address" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "agreement_acceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agreement_acceptance_user_id_idx" ON "agreement_acceptance"("user_id");

-- CreateIndex
CREATE INDEX "agreement_acceptance_restaurant_id_idx" ON "agreement_acceptance"("restaurant_id");

-- CreateIndex
CREATE INDEX "agreement_acceptance_agreement_version_idx" ON "agreement_acceptance"("agreement", "version");

-- AddForeignKey
ALTER TABLE "agreement_acceptance" ADD CONSTRAINT "agreement_acceptance_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreement_acceptance" ADD CONSTRAINT "agreement_acceptance_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- ADR-049: the agreement type determines which subject column is set.
--
-- Same single-row CHECK pattern as ADR-017's journal_entry_compensating_fk_matches_type,
-- and for the same reason: two nullable FKs with a rule about which one applies is only a
-- convention until the database enforces it. Without this, one mis-typed insert stores a
-- platform-terms acceptance against a Restaurant and the table quietly means two things.
-- ============================================================================

ALTER TABLE agreement_acceptance
  ADD CONSTRAINT agreement_acceptance_subject_matches_type
  CHECK (
    (agreement = 'platform_terms'
      AND user_id IS NOT NULL AND restaurant_id IS NULL)
    OR (agreement = 'stripe_connected_account'
      AND restaurant_id IS NOT NULL AND user_id IS NULL)
  );

-- A version string that is present but empty would satisfy NOT NULL while answering nothing —
-- the same "empty string is a present value" class this project has now been bitten by four times.
ALTER TABLE agreement_acceptance
  ADD CONSTRAINT agreement_acceptance_version_not_blank
  CHECK (length(btrim(version)) > 0);
