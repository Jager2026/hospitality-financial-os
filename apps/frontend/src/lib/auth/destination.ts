/**
 * Where a person lands after signing in — `UX_MAP.md`, "Getting In", Log In.
 *
 * A pure function on the Memberships the login response returns, deliberately separated from the
 * screen that calls it. This is the one piece of routing the entire Portal inherits: every other
 * screen is reached from wherever this sends someone, so it earns a test of its own rather than
 * only being exercised through a form.
 */

export interface SessionMembership {
  id: string;
  organizationId: string;
  /** `null` means the Membership is organization-wide rather than scoped to one Restaurant. */
  restaurantId: string | null;
  /**
   * The Role and its Permissions, exactly as the login response has always sent them
   * (`auth.service.ts`, `toAuthResult`). **The API was never the missing part — this type was**:
   * it described three of the four fields, so nothing in the Portal could ask what a person is
   * allowed to do, and every screen either showed an action to everyone or hid it from everyone.
   *
   * Optional on the type because a session stored by an older build of the Portal will not have
   * it, and a screen reading a stale `localStorage` entry must degrade rather than throw.
   */
  role?: {
    id: string;
    name: string;
    permissions: string[];
  };
}

export const CREATE_RESTAURANT_PATH = "/onboarding/restaurant";
export const RESTAURANTS_PATH = "/restaurants";

export function restaurantDashboardPath(restaurantId: string): string {
  return `/restaurants/${restaurantId}`;
}

/**
 * The three-way fork, exactly as `UX_MAP.md` states it:
 *   - no Memberships at all -> Create Your Restaurant. This is where a just-registered owner goes;
 *     `DATABASE.md` explicitly allows a User with zero Memberships, so it is a normal state and
 *     not an error.
 *   - an organization-wide Membership -> the Restaurants list.
 *   - a single restaurant-scoped Membership -> that Restaurant's Dashboard.
 *
 * One case `UX_MAP.md` does not cover: **more than one restaurant-scoped Membership and no
 * org-wide one** — a waiter or manager working at two restaurants on the platform, which ADR-006
 * explicitly supports. Sending them to a single Dashboard would mean silently choosing one of
 * their employers, so they go to the list and choose. Flagged rather than decided quietly; if the
 * Founder wants a different answer, this function is where it changes.
 */
export function destinationAfterLogin(memberships: SessionMembership[]): string {
  if (memberships.length === 0) return CREATE_RESTAURANT_PATH;

  const scoped = memberships.filter((m) => m.restaurantId !== null);
  const hasOrgWide = memberships.some((m) => m.restaurantId === null);

  if (!hasOrgWide && scoped.length === 1) {
    return restaurantDashboardPath(scoped[0].restaurantId as string);
  }
  return RESTAURANTS_PATH;
}
