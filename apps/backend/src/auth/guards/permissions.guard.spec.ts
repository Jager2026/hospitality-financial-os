import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { AppException } from "../../common/exceptions/app.exception";
import { PermissionsGuard } from "./permissions.guard";

function contextWithUser(user: unknown): ExecutionContext {
  const request = { user };
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function fakeReflector(required: string | undefined): Reflector {
  return { getAllAndOverride: vi.fn().mockReturnValue(required) } as unknown as Reflector;
}

// Written as groundwork before the first `@RequirePermission` caller existed. **Sixteen routes
// across seven controllers now depend on it**, so the original note — "not exercised anywhere yet"
// — described a state that ended eleven sprints ago while still reading as current. `CLAUDE.md`
// cites this very comment as the shape to watch for: a plan that outlives its sprint and goes on
// looking like one.
//
// What the tests below still protect is unchanged and now load-bearing rather than anticipatory:
// `some` silently becoming `every`, or the check being inverted, would fail every gated route at
// once.
//
// Note what they do NOT touch: the fixtures here name no Role and use an arbitrary permission
// string, deliberately. This guard is a pure function over the shape — it never reads the
// database — so a seeded Role would add a dependency without adding proof.
describe("PermissionsGuard", () => {
  it("allows the request through when the route has no @RequirePermission", () => {
    const guard = new PermissionsGuard(fakeReflector(undefined));

    expect(guard.canActivate(contextWithUser(undefined))).toBe(true);
  });

  it("throws a developer error (not a silent pass) if it runs before JwtAuthGuard attached a user", () => {
    const guard = new PermissionsGuard(fakeReflector("restaurant.edit"));

    expect(() => guard.canActivate(contextWithUser(undefined))).toThrow(
      /add JwtAuthGuard before it/,
    );
  });

  it("rejects with PERMISSION_DENIED (403) when no Membership's role carries the required permission", () => {
    const guard = new PermissionsGuard(fakeReflector("restaurant.edit"));
    const user = { memberships: [{ role: { permissions: ["profile.view"] } }] };

    let caught: unknown;
    try {
      guard.canActivate(contextWithUser(user));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppException);
    expect((caught as AppException).code).toBe("PERMISSION_DENIED");
    expect((caught as AppException).getStatus()).toBe(403);
  });

  it("allows the request through when at least one Membership's role carries the required permission", () => {
    const guard = new PermissionsGuard(fakeReflector("restaurant.edit"));
    const user = {
      memberships: [
        { role: { permissions: ["profile.view"] } },
        { role: { permissions: ["restaurant.edit"] } },
      ],
    };

    expect(guard.canActivate(contextWithUser(user))).toBe(true);
  });
});
