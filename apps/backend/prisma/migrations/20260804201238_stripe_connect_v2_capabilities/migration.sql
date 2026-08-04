/*
  Warnings:

  - You are about to drop the column `charges_enabled` on the `restaurant` table. All the data in the column will be lost.
  - You are about to drop the column `payouts_enabled` on the `restaurant` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "restaurant" DROP COLUMN "charges_enabled",
DROP COLUMN "payouts_enabled",
ADD COLUMN     "card_payments_status" TEXT,
ADD COLUMN     "payouts_status" TEXT;
