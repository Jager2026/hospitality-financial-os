import type { Restaurant } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { AppException } from "./exceptions/app.exception";
import type { PrismaService } from "../prisma/prisma.service";

/** ADR-005 reachability rule, byte-identical to the predicate already duplicated in
 * RestaurantService.getReachableRestaurantOrThrow and TransactionService.assertReachable: an
 * org-wide Membership reaches every Restaurant in its own Organization; a restaurant-scoped one
 * reaches only the exact Restaurant it names — never "any org-wide Membership anywhere"
 * (CLAUDE_RULES.md's Architecture Review paragraph on this exact bug shape). Extracted here on
 * this pattern's fourth occurrence (Dashboard, Sprint 9) rather than copy-pasted again.
 *
 * ── CORRECTION (Sprint 14). The sentence that used to end this paragraph read: "the three
 * existing call sites are left as-is to avoid unrelated churn in already-shipped modules."
 * **There are now thirteen.**
 *
 * That is a different kind of staleness from an ordinary out-of-date comment, and worth naming:
 * the exception to a decision was recorded accurately, and then **the exception silently grew**.
 * Nobody widened it deliberately; each new module simply wrote the predicate inline, and the
 * comment went on describing a boundary that had stopped being true. It still *read* as precise,
 * which is what made it invisible — the same failure mode as the "Sprint 3+" extension point in
 * `permissions.guard.ts`, which outlived its sprint by eleven while looking like a plan.
 *
 * The count matters here more than it usually would. **This exact predicate has already shipped
 * wrong twice** — `RestaurantService.findAllForUser` and `TipService.assertReachable`, both by
 * treating `restaurantId === null` as proof of reach without comparing `organizationId`. The
 * Architecture Review paragraph in `CLAUDE.md` exists because of those two. Thirteen
 * independently-maintained copies of a predicate the project has twice got wrong is a risk
 * surface, not an aesthetic complaint.
 *
 * ── RESOLVED (ADR-047). Ten of the thirteen now call these helpers; three are excluded on purpose
 * and the reasoning is recorded further down this file, next to the functions they must not use.
 *
 * The count is no longer maintained by hand, which is the part that matters — `repo-invariants.spec.ts`
 * fails if this predicate is written inline anywhere in the backend outside this file. That check
 * exists because the previous bound was a sentence, and a sentence cannot notice being outgrown:
 * this one said "three" while the number climbed to thirteen, and stayed convincing the whole
 * time. **An accurate comment about an access rule is worth less than a check that fails.** */
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
  return findGrantingMembership(user, restaurant, permission) !== undefined;
}

/**
 * The same check as `hasPermissionAtRestaurant`, returning the Membership that grants it rather
 * than a boolean — `PaymentService.getGrantingMembershipOrThrow` needs the row, not the answer.
 *
 * Added so that call site could join the consolidation without its signature being bent to fit a
 * shared helper. `.some(p)` and `.find(p) !== undefined` are the same test over the same
 * predicate, so `hasPermissionAtRestaurant` is now defined in terms of this and there is exactly
 * one implementation of the rule rather than two that happen to agree.
 *
 * Worth recording, since it was checked rather than assumed: payment's caller currently discards
 * the returned Membership (`payment.service.ts:59`), so the `find`/`some` distinction is not
 * observable today. The return type is preserved anyway — narrowing it would be a change to a
 * money-path signature made for the convenience of a refactor, which is not a trade this refactor
 * is entitled to make.
 */
export function findGrantingMembership(
  user: AuthenticatedUser,
  restaurant: { id: string; organizationId: string },
  permission: string,
): AuthenticatedUser["memberships"][number] | undefined {
  return user.memberships.find(
    (m) =>
      (m.restaurantId === restaurant.id ||
        (m.restaurantId === null && m.organizationId === restaurant.organizationId)) &&
      m.role.permissions.includes(permission),
  );
}

/**
 * ── WHAT THESE HELPERS ARE NOT FOR, and why the exclusion is a safety property rather than tidiness.
 *
 * Every function above takes a **Restaurant**. Its `id` is non-null by definition, which is the
 * only reason `m.restaurantId === restaurant.id` is a safe first comparison.
 *
 * Three call sites in this codebase look identical and are not: they reach a **Membership** or a
 * **Wallet**, whose `restaurantId` is legitimately nullable —
 * `MembershipService.getReachableOrThrow`, `MembershipService.assertPermission`, and
 * `WalletService.assertReachable`. They are deliberately excluded from these helpers and must
 * stay excluded.
 *
 * **The reason is no longer a judgement call; it was proved.** When the target is org-wide, the
 * first comparison becomes `null === null` — true for any caller holding an org-wide Membership in
 * ANY Organization — and `||` short-circuits before the `organizationId` comparison ever runs.
 * `MembershipService` shipped exactly that and leaked across Organizations: an unrelated org-wide
 * Owner could read another Organization's org-wide Membership in full, and re-role it (fixed and
 * covered by `membership.service.spec.ts`; found while surveying these very call sites).
 * `WalletService` faces the same nullable target and is correct, because it refuses org-wide
 * Wallets outright with an explicit `restaurantId !== null` guard before testing anything else.
 *
 * So the two nullable-target sites, which read like the same call, differ on precisely the check
 * that decides — and one of them was wrong. **Folding them into a shared helper would have
 * propagated whichever version was chosen, and the broken one is the one that reads like the
 * others.** Three honest copies of a rule are safer than eleven honest ones plus two pretending to
 * be the same call.
 */

/** The combined "reachable + carries the given permission" check, thrown as a wrapper this time —
 * unlike the call sites Sprint 9 left untouched (each had its own slightly different not-found
 * message/code, and there turned out to be thirteen rather than three; see the correction at the
 * top of this file), Dashboard and Analytics (ADR-026/027) share
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
