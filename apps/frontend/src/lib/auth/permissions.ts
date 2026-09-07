import type { SessionMembership } from "./destination";

/**
 * Whether the signed-in person holds a Permission **at a particular Restaurant**.
 *
 * ── Read this first: what this is NOT ──────────────────────────────────────────────────────────
 *
 * **This is not a security check, and nothing may ever be protected by it alone.** It runs in the
 * browser, on data the browser holds, and a person who wants past it needs no more than developer
 * tools. The real check is `restaurant.service.ts`, which answers a request from a Manager or a
 * Waiter with a 404 whatever this function said.
 *
 * What it is for is honesty of presentation: offering a button that the server will refuse teaches
 * an owner's staff that the product is broken, when the product is working exactly as designed.
 *
 * ── The rule itself, and the specific way it has been got wrong twice ──────────────────────────
 *
 * A Membership reaches a Restaurant if it is **org-wide in that Restaurant's own Organization**,
 * or **scoped to that Restaurant**. The trap `CLAUDE.md` records — twice shipped, once caught in
 * review — is testing `restaurantId === null` alone as proof of reach. An org-wide Membership only
 * proves the holder is org-wide *somewhere*; without comparing `organizationId`, any org-wide
 * Membership in any Organization would satisfy it, which is one Organization reading another's.
 *
 * The consequence here is milder than on the server — a wrongly shown button, not leaked data —
 * but the rule is written the same way on purpose. A predicate that is correct in one place and
 * approximated in another is how the approximation eventually gets copied back.
 */
export interface RestaurantScope {
  id: string;
  organizationId: string;
}

export function hasPermissionAtRestaurant(
  memberships: SessionMembership[] | null | undefined,
  restaurant: RestaurantScope | null | undefined,
  permission: string,
): boolean {
  if (!memberships || !restaurant) return false;

  return memberships.some((m) => {
    const reaches =
      m.restaurantId === restaurant.id ||
      (m.restaurantId === null && m.organizationId === restaurant.organizationId);
    return reaches && (m.role?.permissions ?? []).includes(permission);
  });
}

/** The Permission that governs Stripe onboarding, named once so the screen and the tests agree.
 * `restaurant.create` rather than a new one: `POST /restaurants` is the call that CREATES the
 * Stripe Connect account, and finishing that account is the same act continued (#125). */
export const STRIPE_ONBOARDING_PERMISSION = "restaurant.create";
