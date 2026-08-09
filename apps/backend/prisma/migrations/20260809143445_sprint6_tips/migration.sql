-- AlterTable
ALTER TABLE "payment" ADD COLUMN     "tip_amount" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "waiter_membership_id" UUID;

-- AlterTable
ALTER TABLE "restaurant" ADD COLUMN     "tip_presets" INTEGER[] DEFAULT ARRAY[10, 15, 20]::INTEGER[];

-- CreateIndex
CREATE INDEX "payment_waiter_membership_id_idx" ON "payment"("waiter_membership_id");

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_waiter_membership_id_fkey" FOREIGN KEY ("waiter_membership_id") REFERENCES "membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
