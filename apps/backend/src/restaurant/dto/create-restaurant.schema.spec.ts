import { describe, expect, it } from "vitest";
import { createRestaurantSchema } from "./create-restaurant.schema";

const VALID = {
  name: "Test Restaurant",
  legalName: "Test Restaurant UAB",
  companyNumber: "123456789",
  vatNumber: "LT123456789",
  email: "owner@example.com",
  phone: "+37060000000",
  country: "lt",
  currency: "eur",
  timezone: "Europe/Vilnius",
  address: "Gedimino pr. 1, Vilnius",
};

describe("createRestaurantSchema", () => {
  it("accepts a valid restaurant and uppercases country/currency", () => {
    const result = createRestaurantSchema.parse(VALID);
    expect(result.country).toBe("LT");
    expect(result.currency).toBe("EUR");
    expect(result.defaultCustomerLocale).toBe("en"); // default
  });

  it("rejects a country code that isn't exactly 2 characters", () => {
    expect(() => createRestaurantSchema.parse({ ...VALID, country: "LTU" })).toThrow();
  });

  it("rejects a currency code that isn't exactly 3 characters", () => {
    expect(() => createRestaurantSchema.parse({ ...VALID, currency: "EU" })).toThrow();
  });

  it("rejects a malformed email", () => {
    expect(() => createRestaurantSchema.parse({ ...VALID, email: "not-an-email" })).toThrow();
  });

  it("rejects an unsupported locale", () => {
    expect(() => createRestaurantSchema.parse({ ...VALID, defaultCustomerLocale: "de" })).toThrow();
  });

  it("does not accept a client-supplied organizationId as part of the schema", () => {
    // Whether or not extra keys are silently stripped, the parsed result must never carry one —
    // which Organization a Restaurant belongs to is never client input (see the schema's own
    // comment). This is the actual security-relevant guarantee, not just "extra keys exist."
    const result = createRestaurantSchema.parse({ ...VALID, organizationId: "attacker-supplied" });
    expect((result as Record<string, unknown>).organizationId).toBeUndefined();
  });
});
