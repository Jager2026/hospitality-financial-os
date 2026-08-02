-- CreateEnum
CREATE TYPE "entity_status" AS ENUM ('active', 'inactive', 'suspended');

-- CreateEnum
CREATE TYPE "onboarding_status" AS ENUM ('not_started', 'in_progress', 'complete', 'restricted');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('pending', 'succeeded', 'failed', 'canceled', 'declined');

-- CreateEnum
CREATE TYPE "transaction_status" AS ENUM ('completed', 'partially_refunded', 'refunded', 'disputed');

-- CreateEnum
CREATE TYPE "journal_entry_type" AS ENUM ('payment_captured', 'tip_allocated', 'refund_issued', 'chargeback', 'adjustment', 'payout');

-- CreateEnum
CREATE TYPE "ledger_account" AS ENUM ('processor_clearing', 'restaurant_revenue_payable', 'tip_payable', 'platform_fee_revenue', 'tax_payable', 'refund_contra');

-- CreateEnum
CREATE TYPE "ledger_direction" AS ENUM ('debit', 'credit');

-- CreateEnum
CREATE TYPE "tip_status" AS ENUM ('pending', 'allocated', 'reversed');

-- CreateEnum
CREATE TYPE "refund_status" AS ENUM ('pending', 'succeeded', 'failed', 'canceled');

-- CreateEnum
CREATE TYPE "chargeback_status" AS ENUM ('under_review', 'won', 'lost');

-- CreateEnum
CREATE TYPE "idempotency_key_status" AS ENUM ('in_progress', 'completed', 'failed');

-- CreateTable
CREATE TABLE "organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "entity_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "company_number" TEXT NOT NULL,
    "vat_number" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "country" CHAR(2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "default_customer_locale" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "logo_url" TEXT,
    "status" "entity_status" NOT NULL DEFAULT 'active',
    "stripe_account_id" TEXT,
    "onboarding_status" "onboarding_status" NOT NULL DEFAULT 'not_started',
    "charges_enabled" BOOLEAN NOT NULL DEFAULT false,
    "payouts_enabled" BOOLEAN NOT NULL DEFAULT false,
    "requirements_due" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "restaurant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "two_factor_enabled" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "last_login" TIMESTAMP(3),
    "status" "entity_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "restaurant_id" UUID,
    "role_id" UUID NOT NULL,
    "status" "entity_status" NOT NULL DEFAULT 'active',
    "hire_date" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "currency" (
    "code" CHAR(3) NOT NULL,
    "exponent" INTEGER NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "currency_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "wallet" (
    "id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "available_balance" BIGINT NOT NULL DEFAULT 0,
    "pending_balance" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "status" "entity_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "processor" TEXT NOT NULL,
    "processor_payment_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "payment_status" NOT NULL DEFAULT 'pending',
    "payment_method" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "gross_amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "transaction_status" NOT NULL DEFAULT 'completed',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entry" (
    "id" UUID NOT NULL,
    "entry_type" "journal_entry_type" NOT NULL,
    "transaction_id" UUID,
    "refund_id" UUID,
    "chargeback_id" UUID,
    "adjustment_id" UUID,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_line" (
    "id" UUID NOT NULL,
    "journal_entry_id" UUID NOT NULL,
    "account" "ledger_account" NOT NULL,
    "direction" "ledger_direction" NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "restaurant_id" UUID,
    "membership_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tip" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "gross_tip" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "tip_status" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "processor_refund_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "tip_refunded" BOOLEAN NOT NULL,
    "requested_by" UUID,
    "approved_by" UUID,
    "status" "refund_status" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chargeback" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "processor_dispute_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "chargeback_status" NOT NULL DEFAULT 'under_review',
    "evidence_due_by" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chargeback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adjustment" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID,
    "membership_id" UUID,
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" UUID NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "key" TEXT NOT NULL,
    "endpoint_scope" TEXT NOT NULL,
    "request_fingerprint" TEXT NOT NULL,
    "status" "idempotency_key_status" NOT NULL DEFAULT 'in_progress',
    "response_snapshot" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "entity" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "metadata" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_stripe_account_id_key" ON "restaurant"("stripe_account_id");

-- CreateIndex
CREATE INDEX "restaurant_organization_id_idx" ON "restaurant"("organization_id");

-- CreateIndex
CREATE INDEX "restaurant_currency_idx" ON "restaurant"("currency");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "membership_user_id_idx" ON "membership"("user_id");

-- CreateIndex
CREATE INDEX "membership_organization_id_idx" ON "membership"("organization_id");

-- CreateIndex
CREATE INDEX "membership_restaurant_id_idx" ON "membership"("restaurant_id");

-- CreateIndex
CREATE INDEX "membership_role_id_idx" ON "membership"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_name_key" ON "role"("name");

-- CreateIndex
CREATE UNIQUE INDEX "permission_name_key" ON "permission"("name");

-- CreateIndex
CREATE INDEX "role_permission_permission_id_idx" ON "role_permission"("permission_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_membership_id_key" ON "wallet"("membership_id");

-- CreateIndex
CREATE INDEX "wallet_currency_idx" ON "wallet"("currency");

-- CreateIndex
CREATE UNIQUE INDEX "payment_idempotency_key_key" ON "payment"("idempotency_key");

-- CreateIndex
CREATE INDEX "payment_restaurant_id_idx" ON "payment"("restaurant_id");

-- CreateIndex
CREATE INDEX "payment_currency_idx" ON "payment"("currency");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_payment_id_key" ON "transaction"("payment_id");

-- CreateIndex
CREATE INDEX "transaction_restaurant_id_idx" ON "transaction"("restaurant_id");

-- CreateIndex
CREATE INDEX "transaction_restaurant_id_created_at_idx" ON "transaction"("restaurant_id", "created_at");

-- CreateIndex
CREATE INDEX "transaction_currency_idx" ON "transaction"("currency");

-- CreateIndex
CREATE INDEX "journal_entry_transaction_id_idx" ON "journal_entry"("transaction_id");

-- CreateIndex
CREATE INDEX "journal_entry_refund_id_idx" ON "journal_entry"("refund_id");

-- CreateIndex
CREATE INDEX "journal_entry_chargeback_id_idx" ON "journal_entry"("chargeback_id");

-- CreateIndex
CREATE INDEX "journal_entry_adjustment_id_idx" ON "journal_entry"("adjustment_id");

-- CreateIndex
CREATE INDEX "ledger_line_journal_entry_id_idx" ON "ledger_line"("journal_entry_id");

-- CreateIndex
CREATE INDEX "ledger_line_membership_id_idx" ON "ledger_line"("membership_id");

-- CreateIndex
CREATE INDEX "ledger_line_restaurant_id_idx" ON "ledger_line"("restaurant_id");

-- CreateIndex
CREATE INDEX "ledger_line_currency_idx" ON "ledger_line"("currency");

-- CreateIndex
CREATE UNIQUE INDEX "tip_transaction_id_key" ON "tip"("transaction_id");

-- CreateIndex
CREATE INDEX "tip_currency_idx" ON "tip"("currency");

-- CreateIndex
CREATE INDEX "refund_transaction_id_idx" ON "refund"("transaction_id");

-- CreateIndex
CREATE INDEX "refund_requested_by_idx" ON "refund"("requested_by");

-- CreateIndex
CREATE INDEX "refund_approved_by_idx" ON "refund"("approved_by");

-- CreateIndex
CREATE INDEX "refund_currency_idx" ON "refund"("currency");

-- CreateIndex
CREATE INDEX "chargeback_transaction_id_idx" ON "chargeback"("transaction_id");

-- CreateIndex
CREATE INDEX "chargeback_currency_idx" ON "chargeback"("currency");

-- CreateIndex
CREATE INDEX "adjustment_restaurant_id_idx" ON "adjustment"("restaurant_id");

-- CreateIndex
CREATE INDEX "adjustment_membership_id_idx" ON "adjustment"("membership_id");

-- CreateIndex
CREATE INDEX "adjustment_created_by_idx" ON "adjustment"("created_by");

-- CreateIndex
CREATE INDEX "adjustment_currency_idx" ON "adjustment"("currency");

-- CreateIndex
CREATE INDEX "outbox_event_published_at_idx" ON "outbox_event"("published_at");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE INDEX "audit_log_user_id_idx" ON "audit_log"("user_id");

-- CreateIndex
CREATE INDEX "audit_log_entity_entity_id_idx" ON "audit_log"("entity", "entity_id");

-- AddForeignKey
ALTER TABLE "restaurant" ADD CONSTRAINT "restaurant_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant" ADD CONSTRAINT "restaurant_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet" ADD CONSTRAINT "wallet_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet" ADD CONSTRAINT "wallet_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_idempotency_key_fkey" FOREIGN KEY ("idempotency_key") REFERENCES "idempotency_keys"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refund"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_chargeback_id_fkey" FOREIGN KEY ("chargeback_id") REFERENCES "chargeback"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_adjustment_id_fkey" FOREIGN KEY ("adjustment_id") REFERENCES "adjustment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_line" ADD CONSTRAINT "ledger_line_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_line" ADD CONSTRAINT "ledger_line_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_line" ADD CONSTRAINT "ledger_line_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_line" ADD CONSTRAINT "ledger_line_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tip" ADD CONSTRAINT "tip_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tip" ADD CONSTRAINT "tip_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chargeback" ADD CONSTRAINT "chargeback_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chargeback" ADD CONSTRAINT "chargeback_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adjustment" ADD CONSTRAINT "adjustment_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adjustment" ADD CONSTRAINT "adjustment_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adjustment" ADD CONSTRAINT "adjustment_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adjustment" ADD CONSTRAINT "adjustment_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
