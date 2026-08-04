import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AppException } from "../../common/exceptions/app.exception";
import type { PrismaService } from "../../prisma/prisma.service";
import type { TokenService } from "../token.service";
import { JwtAuthGuard, type AuthenticatedRequest } from "./jwt-auth.guard";

function contextWithRequest(request: Partial<AuthenticatedRequest>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
}

// DoD (IMPLEMENTATION_PLAN.md, Sprint 2): "Protected routes work." Only ever exercised manually
// via curl before now (no token → 401, valid token → 200) — nothing here would have caught the
// guard silently letting an unauthenticated request through.
describe("JwtAuthGuard", () => {
  it("rejects a request with no Authorization header, without calling TokenService", async () => {
    const verifyAccessToken = vi.fn();
    const guard = new JwtAuthGuard(
      { verifyAccessToken } as unknown as TokenService,
      { user: { findUnique: vi.fn() } } as unknown as PrismaService,
    );

    let caught: unknown;
    try {
      await guard.canActivate(contextWithRequest({ headers: {} } as AuthenticatedRequest));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppException);
    expect((caught as AppException).getStatus()).toBe(401);
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it("rejects a header missing the 'Bearer ' prefix, without calling TokenService", async () => {
    const verifyAccessToken = vi.fn();
    const guard = new JwtAuthGuard(
      { verifyAccessToken } as unknown as TokenService,
      { user: { findUnique: vi.fn() } } as unknown as PrismaService,
    );
    const request = {
      headers: { authorization: "Token abc.def.ghi" },
    } as unknown as AuthenticatedRequest;

    await expect(guard.canActivate(contextWithRequest(request))).rejects.toBeInstanceOf(
      AppException,
    );
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it("rejects a syntactically valid token whose user no longer exists or is inactive", async () => {
    const verifyAccessToken = vi
      .fn()
      .mockResolvedValue({ sub: "user-1", jti: "jti-1", type: "access" });
    const findUnique = vi.fn().mockResolvedValue(null);
    const guard = new JwtAuthGuard(
      { verifyAccessToken } as unknown as TokenService,
      { user: { findUnique } } as unknown as PrismaService,
    );
    const request = {
      headers: { authorization: "Bearer a.b.c" },
    } as unknown as AuthenticatedRequest;

    await expect(guard.canActivate(contextWithRequest(request))).rejects.toBeInstanceOf(
      AppException,
    );
  });

  it("attaches request.user with mapped memberships/permissions and allows a valid token through", async () => {
    const verifyAccessToken = vi
      .fn()
      .mockResolvedValue({ sub: "user-1", jti: "jti-1", type: "access" });
    const dbUser = {
      id: "user-1",
      email: "guarded@example.com",
      locale: "en",
      deletedAt: null,
      status: "ACTIVE",
      memberships: [
        {
          id: "m1",
          organizationId: "org-1",
          restaurantId: null,
          role: {
            id: "role-1",
            name: "Owner",
            rolePermissions: [{ permission: { name: "restaurant.edit" } }],
          },
        },
      ],
    };
    const findUnique = vi.fn().mockResolvedValue(dbUser);
    const guard = new JwtAuthGuard(
      { verifyAccessToken } as unknown as TokenService,
      { user: { findUnique } } as unknown as PrismaService,
    );
    const request = {
      headers: { authorization: "Bearer a.b.c" },
    } as unknown as AuthenticatedRequest;

    const allowed = await guard.canActivate(contextWithRequest(request));

    expect(allowed).toBe(true);
    expect(request.user).toEqual({
      id: "user-1",
      email: "guarded@example.com",
      locale: "en",
      memberships: [
        {
          id: "m1",
          organizationId: "org-1",
          restaurantId: null,
          role: { id: "role-1", name: "Owner", permissions: ["restaurant.edit"] },
        },
      ],
    });
  });
});
