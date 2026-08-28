import type { Restaurant } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { AppException } from "./exceptions/app.exception";
import type { PrismaService } from "../prisma/prisma.service";

/** ADR-005 reachability rule, byte-identical to the predicate already duplicated in
 * RestaurantService.getReachableRestaurantOrThrow and TransactionService.assertReachable: an
 * org-wide Membership reaches every Restaurant in its own Organization; a restaurant-scoped one
 * reaches only the exact Restaurant it names — never "any org-wide Membership anywhere"
 * (CLAUDE_RULES.md's Architecture Review paragraph on this exact bug shape). Extracted here on
 * this pattern's fourth occurrence (Dashboard, Sprint 9) rather than copy-pasted again; the three
 * existing call sites are left as-is to avoid unrelated churn in already-shipped modules. */
export function isRestaurantReachable(
  user: AuthenticatedUser,
  restaurant: { id: string; organizationId: string },
): boolean {
  return user.memberships.some(
    (m) =>
      m.restaurantId === restaurant.id ||
      (m.restaurantId === null && m.organizationId === restaurant.organizationId),
  );
}

/**
 * The reachability predicate for a **list** query, narrowed to Memberships that actually carry the
 * permission — ADR-043.
 *
 * `isRestaurantReachable` and `hasPermissionAtRestaurant` above answer for one known Restaurant.
 * A list query has no such Restaurant: it builds a `WHERE` from every Membership the caller holds.
 * Doing that without the permission filter is where the leak was, and the shape is worth naming
 * because it is invisible in review:
 *
 *   - `PermissionsGuard` asks "does this caller hold the permission on **any** Membership."
 *   - the list builds its scope from **every** Membership.
 *   - **nothing asks whether those are the same Membership.**
 *
 * So a permission held in one Organization silently widens a list built from a Membership in
 * another. Proved rather than argued: a zero-permission Waiter exported another restaurant's
 * transaction rows, with the amounts in them.
 *
 * Returns the ids to scope by. Callers pass the permission the route requires, so the filter and
 * the route's own `@RequirePermission` can never disagree.
 */
export function permittedScope(
  user: AuthenticatedUser,
  permission: string,
): { organizationIds: string[]; restaurantIds: string[] } {
  const carrying = user.memberships.filter((m) => m.role.permissions.includes(permission));
  return {
    organizationIds: [
      ...new Set(carrying.filter((m) => m.restaurantId === null).map((m) => m.organizationId)),
    ],
    restaurantIds: [
      ...new Set(
        carrying.filter((m) => m.restaurantId !== null).map((m) => m.restaurantId as string),
      ),
    ],
  };
}

/** Fine-grained, per-resource permission check — same shape as RestaurantService.assertPermission.
 * PermissionsGuard only checks "does the user hold this permission on ANY Membership" (a fast
 * global reject); this checks whether one of the SPECIFIC Memberships that actually reaches this
 * Restaurant carries the permission, so a Manager's `reports.view` at Restaurant A can never leak
 * into reading Restaurant B's dashboard just because they also hold an unrelated Membership there
 * without the permission. */
export function hasPermissionAtRestaurant(
  user: AuthenticatedUser,
  restaurant: { id: string; organizationId: string },
  permission: string,
): boolean {
  return user.memberships.some(
    (m) =>
      (m.restaurantId === restaurant.id ||
        (m.restaurantId === null && m.organizationId === restaurant.organizationId)) &&
      m.role.permissions.includes(permission),
  );
}

/** The combined "reachable + carries the given permission" check, thrown as a wrapper this time —
 * unlike the three earlier call sites Sprint 9 deliberately left untouched (each had its own
 * slightly different not-found message/code), Dashboard and Analytics (ADR-026/027) share
 * byte-identical semantics here, same two exception codes. Sharing the throwing wrapper itself,
 * not just the boolean predicates, avoids a second copy of logic that would otherwise need to
 * change in both places every time either module's access rule changes.
 *
 * `permission` defaults to `reports.view` (every Dashboard/Analytics read route) but Analytics'
 * own `/export` routes pass `data.export` instead — the fine-grained check must test the SAME
 * permission the coarse `PermissionsGuard` already required for that specific route, or a caller
 * who holds `data.export` at Restaurant A but only `reports.view` (not `data.export`) at
 * Restaurant B could pass the controller's coarse gate yet be fine-grain-checked against the
 * wrong permission for B — exactly the kind of two-different-numbers-that-could-drift-apart bug
 * this project's own precedent (ADR-021) warns against, just for permissions instead of money. */
export async function getReachableReportingRestaurantOrThrow(
  prisma: PrismaService,
  id: string,
  user: AuthenticatedUser,
  permission: string = "reports.view",
): Promise<Restaurant> {
  const restaurant = await prisma.restaurant.findFirst({ where: { id, deletedAt: null } });
  if (!restaurant || !isRestaurantReachable(user, restaurant)) {
    throw new AppException("RESTAURANT_NOT_FOUND", "Restaurant not found.", 404);
  }
  if (!hasPermissionAtRestaurant(user, restaurant, permission)) {
    throw new AppException("PERMISSION_DENIED", `Missing required permission: ${permission}`, 403);
  }
  return restaurant;
}
