-- CreateTable
CREATE TABLE "membership_invitation" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "restaurant_id" UUID,
    "role_id" UUID NOT NULL,
    "invited_by" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "membership_invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "membership_invitation_email_idx" ON "membership_invitation"("email");

-- AddForeignKey
ALTER TABLE "membership_invitation" ADD CONSTRAINT "membership_invitation_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_invitation" ADD CONSTRAINT "membership_invitation_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_invitation" ADD CONSTRAINT "membership_invitation_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_invitation" ADD CONSTRAINT "membership_invitation_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
