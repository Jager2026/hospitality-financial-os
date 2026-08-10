import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";

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
