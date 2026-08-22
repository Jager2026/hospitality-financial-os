-- ADR-032: production had zero User rows at the moment this migration was written (confirmed
-- directly against the database), so this is safe there without a real backfill decision. Written
-- as add-nullable -> backfill -> set-not-null anyway, not a bare NOT NULL default, so this same
-- migration is also safe to run against any environment (local dev, CI-seeded fixtures) that
-- already has rows — the email-local-part fallback is a reasonable placeholder for pre-existing
-- rows, never shown as the real product default (registration/invite-accept always require a real
-- displayName going forward).
ALTER TABLE "user" ADD COLUMN "display_name" TEXT;

UPDATE "user" SET "display_name" = split_part(email, '@', 1) WHERE "display_name" IS NULL;

ALTER TABLE "user" ALTER COLUMN "display_name" SET NOT NULL;
