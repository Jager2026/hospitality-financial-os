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
 * No current route does this yet (first real caller: Sprint 3+) — this is the mechanism, ready to
 * use, same shape as Sprint 1's Ledger/Idempotency/Outbox modules.
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

    // Extension point (Sprint 3+): once a route carries :restaurantId, filter memberships to
    // those where restaurantId matches (or is null, for an org-wide grant within the same
    // Organization) before checking permissions, instead of checking across every Membership.
    const hasPermission = user.memberships.some((m) => m.role.permissions.includes(required));

    if (!hasPermission) {
      throw new AppException("PERMISSION_DENIED", `Missing required permission: ${required}`, 403);
    }

    return true;
  }
}
