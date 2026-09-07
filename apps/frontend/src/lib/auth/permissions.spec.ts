import { describe, expect, it } from "vitest";
import type { SessionMembership } from "./destination";
import { hasPermissionAtRestaurant, STRIPE_ONBOARDING_PERMISSION } from "./permissions";

const VENUE = { id: "r1", organizationId: "org1" };
const OTHER_VENUE = { id: "r2", organizationId: "org2" };

function membership(over: Partial<SessionMembership> = {}): SessionMembership {
  return {
    id: "m1",
    organizationId: "org1",
    restaurantId: null,
    role: { id: "role-owner", name: "Owner", permissions: [STRIPE_ONBOARDING_PERMISSION] },
    ...over,
  };
}

describe("hasPermissionAtRestaurant", () => {
  it("lets an org-wide Owner act on a restaurant in their own Organization", () => {
    expect(hasPermissionAtRestaurant([membership()], VENUE, STRIPE_ONBOARDING_PERMISSION)).toBe(
      true,
    );
  });

  // THE ONE THE SERVER SHIPPED WRONG TWICE (CLAUDE.md). `restaurantId === null` proves the holder
  // is org-wide SOMEWHERE. Without comparing organizationId, an Owner of one chain would be
  // offered actions on another chain's venue — and an implementation that skipped that comparison
  // would pass every other test in this file.
  it("does not let an org-wide Owner of one Organization act on another's restaurant", () => {
    expect(
      hasPermissionAtRestaurant([membership()], OTHER_VENUE, STRIPE_ONBOARDING_PERMISSION),
      "an org-wide Membership was treated as org-wide everywhere",
    ).toBe(false);
  });

  it("lets a restaurant-scoped Membership act on its own restaurant", () => {
    const scoped = membership({ restaurantId: "r1", organizationId: "org1" });
    expect(hasPermissionAtRestaurant([scoped], VENUE, STRIPE_ONBOARDING_PERMISSION)).toBe(true);
  });

  it("does not let a restaurant-scoped Membership act on a sibling in the same Organization", () => {
    const scoped = membership({ restaurantId: "r9", organizationId: "org1" });
    expect(hasPermissionAtRestaurant([scoped], VENUE, STRIPE_ONBOARDING_PERMISSION)).toBe(false);
  });

  // Reach and permission are two questions, and this is the case that proves both are asked: a
  // Manager reaches the venue perfectly well and still may not set up payments.
  it("refuses a Manager who reaches the venue but lacks the permission", () => {
    const manager = membership({
      role: { id: "role-manager", name: "Manager", permissions: ["restaurant.edit"] },
    });
    expect(hasPermissionAtRestaurant([manager], VENUE, STRIPE_ONBOARDING_PERMISSION)).toBe(false);
  });

  it("refuses a Waiter, who holds no permissions at all", () => {
    const waiter = membership({
      restaurantId: "r1",
      role: { id: "role-waiter", name: "Waiter", permissions: [] },
    });
    expect(hasPermissionAtRestaurant([waiter], VENUE, STRIPE_ONBOARDING_PERMISSION)).toBe(false);
  });

  // A session written by an older build has no `role` at all. The screen must show less, never
  // throw — an exception here would take down a screen whose whole job is to explain a state.
  it("refuses rather than throwing when a stored session predates the role field", () => {
    const legacy = { id: "m1", organizationId: "org1", restaurantId: null } as SessionMembership;
    expect(hasPermissionAtRestaurant([legacy], VENUE, STRIPE_ONBOARDING_PERMISSION)).toBe(false);
  });

  it("refuses when either side is missing", () => {
    expect(hasPermissionAtRestaurant(null, VENUE, STRIPE_ONBOARDING_PERMISSION)).toBe(false);
    expect(hasPermissionAtRestaurant([membership()], null, STRIPE_ONBOARDING_PERMISSION)).toBe(
      false,
    );
  });
});
