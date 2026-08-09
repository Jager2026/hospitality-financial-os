import { z } from "zod";

// API_Contract.md, Create Payment. currency and payment_method are deliberately not client
// fields: currency always mirrors the Restaurant's own fixed Stripe-account currency (DATABASE.md
// Restaurant Rules — the connected account's currency is fixed at creation), and payment_method
// is server-set ("card" — the only method this MVP scope supports) rather than trusted from the
// client before Stripe has actually confirmed anything.
//
// tipAmount (ADR-022, Sprint 6): the caller-submitted tip portion of `amount` — `amount` itself
// stays the full amount charged to the card (bill + tip combined, one Stripe PaymentIntent,
// matching UX_MAP.md's single "Card Payment" step). Optional, defaults to 0. The one real
// invariant worth enforcing here: a tip can never exceed the total charged.
export const createPaymentSchema = z
  .object({
    restaurantId: z.string().uuid(),
    amount: z.number().int().positive(), // minor units (ADR-001) — e.g. 1550 for EUR 15.50
    tipAmount: z.number().int().nonnegative().optional().default(0),
  })
  .refine((data) => data.tipAmount <= data.amount, {
    message: "tipAmount must not exceed amount",
    path: ["tipAmount"],
  });

export type CreatePaymentDto = z.infer<typeof createPaymentSchema>;
