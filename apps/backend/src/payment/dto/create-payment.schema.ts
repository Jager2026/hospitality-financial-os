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
//
// waiterMembershipId (ADR-033): the terminal's own "who actually served this table" selection —
// no longer derived from the authenticated caller (req.user). Required whenever tipAmount > 0
// (enforced below, fail-fast at the request boundary rather than surfacing later as a webhook
// failure — see webhooks.service.ts's own comment on why that path used to be unreachable and now
// genuinely isn't); optional when there's no tip, since there's nobody to attribute it to.
// PaymentService separately validates that a SUBMITTED id is a real, reachable Membership at this
// Restaurant — a DB lookup this schema can't do on its own.
export const createPaymentSchema = z
  .object({
    restaurantId: z.string().uuid(),
    amount: z.number().int().positive(), // minor units (ADR-001) — e.g. 1550 for EUR 15.50
    tipAmount: z.number().int().nonnegative().optional().default(0),
    waiterMembershipId: z.string().uuid().optional(),
  })
  .refine((data) => data.tipAmount <= data.amount, {
    message: "tipAmount must not exceed amount",
    path: ["tipAmount"],
  })
  .refine((data) => data.tipAmount === 0 || !!data.waiterMembershipId, {
    message: "waiterMembershipId is required when tipAmount is greater than 0",
    path: ["waiterMembershipId"],
  });

export type CreatePaymentDto = z.infer<typeof createPaymentSchema>;
