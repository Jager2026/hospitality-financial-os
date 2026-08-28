import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AppException } from "../../common/exceptions/app.exception";
import { REQUIRED_PERMISSION_KEY } from "../decorators/require-permission.decorator";
import type { AuthenticatedRequest } from "./jwt-auth.guard";

/**
 * SYSTEM_ARCHITECTURE.md, Authorization: "A policy check resolves through the current User's
 * Memberships: does the User hold a Membership — either scoped to this specific Restaurant, or
 * org-wide (`restaurant_id IS NULL`) within that Restaurant's Organization — whose Role carries
 * the required Permission."
 *
 * Sprint 2 implements the general form only — no route yet takes a `:restaurantId` param to
 * scope against (the first one is Sprint 3's Restaurant module), so this checks "does the User
 * hold *any* Membership whose Role carries this Permission," not yet "...for *this* Restaurant."
 * Extend at the point marked below when a real restaurant-scoped route exists, rather than
 * guessing the shape now.
 *
 * NOT registered globally, deliberately: NestJS runs global guards (APP_GUARD) before
 * controller/method-level ones, so a global PermissionsGuard would run *before* a route-level
 * `@UseGuards(JwtAuthGuard)` and never see `request.user`. Apply both together, in order, on any
 * route that needs a permission check:
 *   @UseGuards(JwtAuthGuard, PermissionsGuard)
 *   @RequirePermission("restaurant.edit")
 * ── What this guard is, and deliberately is not (ADR-043) ─────────────────────────────────────
 *
 * **This is a coarse pre-filter, by design. It is not the authorization decision.** It answers
 * exactly one question — "does this caller hold the required permission on *any* Membership" —
 * and that is all it can answer, because a guard sees the route, not the rows the route will
 * return.
 *
 * The real, resource-scoped check lives in the services, in two named helpers
 * (`restaurant-reachability.util.ts`):
 *   - `hasPermissionAtRestaurant` / `getReachableReportingRestaurantOrThrow` — one known Restaurant
 *   - `permittedScope` — list queries, which have no single Restaurant to check against
 *
 * **A list route must scope with `permittedScope`. The guard cannot do it for you**, and skipping
 * it is not a style lapse: a permission held in one Organization then silently widens a list built
 * from a Membership in another. That is not hypothetical — it shipped, and
 * `permission-scope.e2e.spec.ts` exported another restaurant's transaction rows to prove it.
 *
 * This paragraph replaces an earlier comment claiming "no current route does this yet (first real
 * caller: Sprint 3+)" and marking the narrowing as an unbuilt extension point. Both had become
 * false — many routes use the guard, and the narrowing exists at the service layer. An outdated
 * comment about a security mechanism is worse than no comment: it tells the next reader the check
 * is missing when it is merely elsewhere, which invites them to "add" it here and remove it there.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string | undefined>(REQUIRED_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (!user) {
      throw new Error(
        "PermissionsGuard ran on a route with @RequirePermission but no request.user — " +
          "add JwtAuthGuard before it: @UseGuards(JwtAuthGuard, PermissionsGuard).",
      );
    }

    // Across every Membership, deliberately — see the header. Narrowing this to the target
    // resource is impossible here (the guard has no rows) and unnecessary (the services do it).
    // What must never happen is a route relying on this line alone to scope data.
    const hasPermission = user.memberships.some((m) => m.role.permissions.includes(required));

    if (!hasPermission) {
      throw new AppException("PERMISSION_DENIED", `Missing required permission: ${required}`, 403);
    }

    return true;
  }
}
