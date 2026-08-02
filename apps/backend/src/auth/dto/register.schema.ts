import { z } from "zod";

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  locale: z.enum(["en", "lt"]).default("en"), // ADR-013
});

export type RegisterDto = z.infer<typeof registerSchema>;
