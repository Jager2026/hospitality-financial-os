import { z } from "zod";

// API_Contract.md, Accept Invitation: password is required only when no User exists yet for
// email — the service decides that, not this schema (it can't know without a database read), so
// password stays optional here and gets validated as required-or-not in the service itself.
// displayName follows the exact same rule (ADR-032) — only meaningful when a new User is actually
// being created here, an existing User already has one.
export const acceptInvitationSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  token: z.string().min(1),
  password: z.string().min(8, "Password must be at least 8 characters").optional(),
  displayName: z.string().trim().min(1, "Display name is required").optional(),
  // ADR-049, and optional here for exactly the same reason as the two fields above: it is required
  // only when this request is the one creating the User. An invitation accepted by somebody who
  // already has an account records nothing — they accepted the terms when they registered, and a
  // second row would claim they agreed twice.
  //
  // The service decides which case this is, because only a database read can tell.
  acceptedTermsVersion: z.string().trim().min(1).optional(),
});

export type AcceptInvitationDto = z.infer<typeof acceptInvitationSchema>;
