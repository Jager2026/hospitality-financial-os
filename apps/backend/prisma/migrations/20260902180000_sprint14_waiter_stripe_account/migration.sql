-- ============================================================================
-- ADR-061: a waiter's Stripe connected account lives on the User, not on a Membership.
--
-- One person, one account: KYC once, carried between venues. A second Membership references
-- the same account through user_id and creates nothing. This is a RECIPIENT account
-- (v2, configuration.recipient, dashboard "none") — it receives transfers and never charges —
-- and must not be confused with restaurant.stripe_account_id, which is a merchant account.
--
-- Generated with `prisma migrate diff --from-schema-datasource --to-schema-datamodel --script`
-- (`migrate dev` refuses a non-interactive shell), then hand-annotated. Column set mirrors the
-- Restaurant's Stripe fields on purpose: same refresh rule (ADR-009 — derived from the live
-- account, never parsed from a webhook payload), same enum.
-- ============================================================================

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "stripe_account_created_at" TIMESTAMP(3),
ADD COLUMN     "stripe_account_id" TEXT,
ADD COLUMN     "stripe_onboarding_status" "onboarding_status" NOT NULL DEFAULT 'not_started',
ADD COLUMN     "stripe_payouts_status" TEXT,
ADD COLUMN     "stripe_requirements_due" JSONB,
ADD COLUMN     "stripe_transfers_status" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "user_stripe_account_id_key" ON "user"("stripe_account_id");

-- A present-but-empty account id would satisfy the UNIQUE index exactly once and then block every
-- later waiter with the same empty string — the "empty string is a present value" class this
-- project has now met five times. NULL means "no account"; anything else must be an id.
ALTER TABLE "user"
  ADD CONSTRAINT "user_stripe_account_id_not_blank"
  CHECK (stripe_account_id IS NULL OR length(btrim(stripe_account_id)) > 0);
