import { describe, expect, it } from "vitest";
import {
  CREATE_RESTAURANT_PATH,
  destinationAfterLogin,
  RESTAURANTS_PATH,
  type SessionMembership,
} from "./destination";

/**
 * The three-way fork from `UX_MAP.md` gets its own tests because **the entire Portal inherits it**:
 * every screen is reached from wherever this sends someone, so a wrong branch here is not a login
 * bug, it is every screen being wrong at once.
 *
 * The e2e suite proves the same fork through a real browser. This proves the decision itself, at
 * every branch including the ones a browser test would need a specially-seeded account to reach.
 */

const orgWide = (organizationId = "org-1"): SessionMembership => ({
  id: `m-${organizationId}-wide`,
  organizationId,
  restaurantId: null,
});

const scoped = (restaurantId: string, organizationId = "org-1"): SessionMembership => ({
  id: `m-${restaurantId}`,
  organizationId,
  restaurantId,
});

describe("destinationAfterLogin", () => {
  it("sends a person with no Memberships to Create Your Restaurant", () => {
    // Not an error state: DATABASE.md explicitly allows a User with zero Memberships, and it is
    // exactly what a just-registered owner has.
    expect(destinationAfterLogin([])).toBe(CREATE_RESTAURANT_PATH);
  });

  it("sends an org-wide Membership to the Restaurants list", () => {
    expect(destinationAfterLogin([orgWide()])).toBe(RESTAURANTS_PATH);
  });

  it("sends a single restaurant-scoped Membership to that Restaurant's Dashboard", () => {
    expect(destinationAfterLogin([scoped("rest-7")])).toBe("/restaurants/rest-7");
  });

  it("prefers the list when someone is BOTH org-wide and scoped — never silently picks one", () => {
    // The discriminating case for the fork's ordering. An implementation that checked "is there
    // exactly one scoped Membership?" first would send an Owner who also waits tables straight
    // past the chain they own and into a single restaurant.
    expect(destinationAfterLogin([orgWide(), scoped("rest-7")])).toBe(RESTAURANTS_PATH);
  });

  it("sends someone scoped to two restaurants to the list, rather than choosing an employer for them", () => {
    // ADR-006 supports working at more than one restaurant on the platform. UX_MAP.md does not
    // cover this case; picking one Dashboard would mean silently choosing between two employers,
    // so they choose. Flagged in `destination.ts` rather than decided quietly.
    expect(destinationAfterLogin([scoped("rest-7"), scoped("rest-9", "org-2")])).toBe(
      RESTAURANTS_PATH,
    );
  });

  it("does not confuse a Restaurant id with an Organization id", () => {
    // A naive implementation that built the path from `organizationId` would pass every test
    // above if the fixtures shared a value. These deliberately do not.
    expect(destinationAfterLogin([scoped("rest-7", "org-42")])).toBe("/restaurants/rest-7");
  });
});
