import { z } from "zod";

// API_Contract.md, RESTAURANTS: POST /restaurants — country/currency are set once here and never
// editable afterward (DATABASE.md Rules: "changing a restaurant's operating country means a new
// Stripe account, never an edit to this row").
export const createRestaurantSchema = z.object({
  name: z.string().min(1).max(200),
  legalName: z.string().min(1).max(200),
  companyNumber: z.string().min(1).max(50),
  vatNumber: z.string().min(1).max(50),
  email: z.string().email(),
  phone: z.string().min(1).max(30),
  country: z.string().length(2).toUpperCase(), // ISO 3166-1 alpha-2
  currency: z.string().length(3).toUpperCase(), // ISO 4217, must exist in Currency table
  defaultCustomerLocale: z.enum(["en", "lt"]).default("en"), // ADR-013
  timezone: z.string().min(1),
  address: z.string().min(1),
  logoUrl: z.string().url().optional(),
  /**
   * The revision of the Stripe connected-account agreement the person was shown (ADR-049).
   *
   * **Required, and the reason it is a field at all is that the other half of ADR-049 was built
   * and never wired up.** The table has carried a `restaurant_id` subject and a
   * `stripe_connected_account` agreement type since Sprint 14, with a CHECK constraint enforcing
   * that pairing — and nothing has ever written a row: the constant existed, its comment said
   * *"accepted when its Stripe connected account is created"*, and this DTO had no field to carry
   * one. A schema built for a record that is never made is worse than no schema, because it reads
   * as though the record exists.
   *
   * Taken from `GET /agreements/current` rather than compiled into the client, for the same reason
   * registration does: a constant in a build may predate the revision, and the client would then
   * be asserting *what a person was shown* from a stale copy. `min(1)` mirrors the second CHECK —
   * a present-but-empty version answers nothing, and the empty string is a present value.
   */
  acceptedStripeAgreementVersion: z.string().min(1),
  // Deliberately no organizationId field here: which Organization a new Restaurant belongs to is
  // never client-supplied. POST /restaurants (bootstrap) creates one; POST /organizations/:id/
  // restaurants takes it from the route param. Either way it's a controller/service-level
  // argument, not something a request body could smuggle in and have honored.
});

export type CreateRestaurantDto = z.infer<typeof createRestaurantSchema>;
