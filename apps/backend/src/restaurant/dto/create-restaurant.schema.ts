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
  // Deliberately no organizationId field here: which Organization a new Restaurant belongs to is
  // never client-supplied. POST /restaurants (bootstrap) creates one; POST /organizations/:id/
  // restaurants takes it from the route param. Either way it's a controller/service-level
  // argument, not something a request body could smuggle in and have honored.
});

export type CreateRestaurantDto = z.infer<typeof createRestaurantSchema>;
