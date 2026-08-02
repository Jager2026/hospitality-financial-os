import { z } from "zod";

// User has no name/display fields in DATABASE.md's schema (id, email, password_hash,
// email_verified, two_factor_enabled, locale, last_login, status) — locale (ADR-013) is the only
// field a self-service profile update can meaningfully touch today. Email/password changes are
// more sensitive (verification, re-auth) and out of Sprint 2's scope, not silently included here.
export const updateProfileSchema = z.object({
  locale: z.enum(["en", "lt"]),
});

export type UpdateProfileDto = z.infer<typeof updateProfileSchema>;
