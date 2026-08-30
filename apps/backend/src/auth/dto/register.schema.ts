import { z } from "zod";

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  // ADR-032: the staff-selection picker needs a real name to show, not an email address —
  // required from every new User going forward, not backfilled onto old rows (none existed in
  // production when this was added).
  displayName: z.string().trim().min(1, "Display name is required"),
  locale: z.enum(["en", "lt"]).default("en"), // ADR-013
  // ADR-049. The revision the client actually displayed, echoed back — not a boolean "agreed".
  // The server checks it against its own current value rather than trusting it: a record naming a
  // revision the user never saw is a false record, and a stale browser tab is the ordinary way one
  // would be produced.
  acceptedTermsVersion: z.string().trim().min(1, "acceptedTermsVersion is required"),
});

export type RegisterDto = z.infer<typeof registerSchema>;
