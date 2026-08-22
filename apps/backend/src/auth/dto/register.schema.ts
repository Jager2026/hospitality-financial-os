import { z } from "zod";

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  // ADR-032: the staff-selection picker needs a real name to show, not an email address —
  // required from every new User going forward, not backfilled onto old rows (none existed in
  // production when this was added).
  displayName: z.string().trim().min(1, "Display name is required"),
  locale: z.enum(["en", "lt"]).default("en"), // ADR-013
});

export type RegisterDto = z.infer<typeof registerSchema>;
