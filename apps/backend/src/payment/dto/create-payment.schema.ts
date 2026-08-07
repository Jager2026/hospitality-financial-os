import { z } from "zod";

// API_Contract.md, Create Payment. currency and payment_method are deliberately not client
// fields: currency always mirrors the Restaurant's own fixed Stripe-account currency (DATABASE.md
// Restaurant Rules — the connected account's currency is fixed at creation), and payment_method
// is server-set ("card" — the only method this MVP scope supports) rather than trusted from the
// client before Stripe has actually confirmed anything.
export const createPaymentSchema = z.object({
  restaurantId: z.string().uuid(),
  amount: z.number().int().positive(), // minor units (ADR-001) — e.g. 1550 for EUR 15.50
});

export type CreatePaymentDto = z.infer<typeof createPaymentSchema>;
