import { describe, expect, it } from "vitest";
import { AgreementsController } from "./agreements.controller";
import {
  CURRENT_PLATFORM_TERMS_VERSION,
  CURRENT_STRIPE_AGREEMENT_VERSION,
} from "../common/agreements/agreement-versions";

describe("AgreementsController", () => {
  // Discriminating in the one way that matters: the whole point of the endpoint is that it serves
  // the same constant `AuthService.register` validates against. A controller with the version typed
  // as a literal — the mistake this guards — would look identical today, because the placeholder is
  // the value either way. It fails the moment either constant changes, which is the moment a
  // literal would start rejecting every registration in production while passing every test.
  it("serves the constants the acceptance path itself uses, never a copy of their current value", () => {
    const result = new AgreementsController().current();

    expect(result.platformTerms.version).toBe(CURRENT_PLATFORM_TERMS_VERSION);
    expect(result.stripeConnectedAccount.version).toBe(CURRENT_STRIPE_AGREEMENT_VERSION);
  });

  it("names both agreements — the Stripe consent is collected by a different screen from the same source", () => {
    const result = new AgreementsController().current();

    expect(Object.keys(result).sort()).toEqual(["platformTerms", "stripeConnectedAccount"]);
  });
});
