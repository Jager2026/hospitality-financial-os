import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppException } from "../common/exceptions/app.exception";
import { AuthService } from "./auth.service";
import { hashPassword } from "./password.util";
import { RefreshTokenReuseDetectedError } from "./token.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { TokenService } from "./token.service";

// Isolates exactly the behavior the Founder asked for: reuse detection must produce its own
// AuditLog row (CLAUDE_RULES.md, Logging Philosophy — "Always log: ... Security Events"), not
// just silently manifest as "the next request happens to fail." A naive fix that catches the
// error only to swallow it, or that logs the wrong action name, passes a shallower test but
// fails this one.
describe("AuthService — refresh token reuse audit logging", () => {
  it("writes a refresh_token_reuse_detected AuditLog row and still rejects the caller", async () => {
    const auditLogCreate = vi.fn().mockResolvedValue({});
    const fakePrisma = { auditLog: { create: auditLogCreate } } as unknown as PrismaService;

    const reuseError = new RefreshTokenReuseDetectedError(
      "33333333-3333-3333-3333-333333333333",
      "44444444-4444-4444-4444-444444444444",
    );
    const fakeTokenService = {
      verifyRefreshToken: vi.fn().mockRejectedValue(reuseError),
    } as unknown as TokenService;

    const authService = new AuthService(fakePrisma, fakeTokenService);

    await expect(
      authService.logout("some-refresh-token", { ipAddress: "203.0.113.5", userAgent: "curl/8.0" }),
    ).rejects.toBe(reuseError);

    expect(auditLogCreate).toHaveBeenCalledTimes(1);
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: {
        userId: "33333333-3333-3333-3333-333333333333",
        entity: "Authentication",
        entityId: "33333333-3333-3333-3333-333333333333",
        action: "refresh_token_reuse_detected",
        metadata: { familyId: "44444444-4444-4444-4444-444444444444" },
        ipAddress: "203.0.113.5",
        userAgent: "curl/8.0",
      },
    });
  });

  it("does NOT write an audit row for an ordinary (non-reuse) refresh failure", async () => {
    const auditLogCreate = vi.fn().mockResolvedValue({});
    const fakePrisma = { auditLog: { create: auditLogCreate } } as unknown as PrismaService;

    const fakeTokenService = {
      verifyRefreshToken: vi.fn().mockRejectedValue(new Error("expired, ordinary failure")),
    } as unknown as TokenService;

    const authService = new AuthService(fakePrisma, fakeTokenService);

    await expect(authService.logout("some-refresh-token")).rejects.toThrow(
      "expired, ordinary failure",
    );
    expect(auditLogCreate).not.toHaveBeenCalled();
  });
});

// DoD (IMPLEMENTATION_PLAN.md, Sprint 2): "Owner can login." Only ever exercised manually via
// curl before now — nothing here failed if a future change broke login, as long as the unrelated
// TokenService/ledger suites kept passing.
describe("AuthService — login", () => {
  // API_Contract.md, Login: "returns Access Token, Refresh Token, User, Memberships" — real gap
  // found live-verifying Sprint 9's Dashboard: the response never actually carried Memberships at
  // all. This test would fail against the pre-fix code (no membership.findMany call existed), and
  // is discriminating against a naive fix too: a fake membership with a real Role/Permission
  // attached, asserting the exact nested shape comes through, not just "the array exists."
  it("returns tokens AND the caller's Memberships (with Role/permissions) for correct credentials, and records lastLogin", async () => {
    const passwordHash = await hashPassword("correct-horse-battery-staple");
    const user = {
      id: "11111111-1111-1111-1111-111111111111",
      email: "login-success@example.com",
      passwordHash,
      locale: "en",
      status: "ACTIVE",
      deletedAt: null,
    };
    const membershipRow = {
      id: "55555555-5555-5555-5555-555555555555",
      organizationId: "66666666-6666-6666-6666-666666666666",
      restaurantId: null,
      role: {
        id: "77777777-7777-7777-7777-777777777777",
        name: "Owner",
        rolePermissions: [{ permission: { name: "reports.view" } }],
      },
    };
    const findUnique = vi.fn().mockResolvedValue(user);
    const update = vi.fn().mockResolvedValue(user);
    const findMany = vi.fn().mockResolvedValue([membershipRow]);
    const fakePrisma = {
      user: { findUnique, update },
      membership: { findMany },
    } as unknown as PrismaService;
    const issueTokenPair = vi
      .fn()
      .mockResolvedValue({ accessToken: "access-tok", refreshToken: "refresh-tok" });
    const fakeTokenService = { issueTokenPair } as unknown as TokenService;

    const authService = new AuthService(fakePrisma, fakeTokenService);
    const result = await authService.login({
      email: "login-success@example.com",
      password: "correct-horse-battery-staple",
    });

    expect(result).toEqual({
      id: user.id,
      accessToken: "access-tok",
      refreshToken: "refresh-tok",
      user: { id: user.id, email: user.email, locale: user.locale },
      memberships: [
        {
          id: membershipRow.id,
          organizationId: membershipRow.organizationId,
          restaurantId: null,
          role: { id: membershipRow.role.id, name: "Owner", permissions: ["reports.view"] },
        },
      ],
    });
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: user.id },
      include: { role: { include: { rolePermissions: { include: { permission: true } } } } },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: user.id },
      data: { lastLogin: expect.any(Date) },
    });
    expect(issueTokenPair).toHaveBeenCalledWith(user.id);
  });

  // A naive implementation that only checks "does a user with this email exist" (skipping
  // verifyPassword, or comparing plaintext) would pass a test that never uses a real hash. This
  // one hashes a DIFFERENT password than the one submitted, so only a genuine bcrypt comparison
  // rejects it.
  it("rejects an incorrect password without issuing tokens or updating lastLogin", async () => {
    const passwordHash = await hashPassword("the-real-password");
    const user = {
      id: "22222222-2222-2222-2222-222222222222",
      email: "login-fail@example.com",
      passwordHash,
      locale: "en",
      status: "ACTIVE",
      deletedAt: null,
    };
    const findUnique = vi.fn().mockResolvedValue(user);
    const update = vi.fn();
    const fakePrisma = { user: { findUnique, update } } as unknown as PrismaService;
    const issueTokenPair = vi.fn();
    const fakeTokenService = { issueTokenPair } as unknown as TokenService;

    const authService = new AuthService(fakePrisma, fakeTokenService);

    let caught: unknown;
    try {
      await authService.login({ email: "login-fail@example.com", password: "totally-wrong" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppException);
    expect((caught as AppException).code).toBe("AUTH_INVALID");
    expect((caught as AppException).getStatus()).toBe(401);
    expect(issueTokenPair).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects a login for an email that doesn't exist, with the same error as a wrong password (no enumeration leak)", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const fakePrisma = { user: { findUnique, update: vi.fn() } } as unknown as PrismaService;
    const fakeTokenService = { issueTokenPair: vi.fn() } as unknown as TokenService;

    const authService = new AuthService(fakePrisma, fakeTokenService);

    let caught: unknown;
    try {
      await authService.login({ email: "nobody@example.com", password: "whatever123" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppException);
    expect((caught as AppException).code).toBe("AUTH_INVALID");
    expect((caught as AppException).getStatus()).toBe(401);
  });
});

// DoD (IMPLEMENTATION_PLAN.md, Sprint 2): "Owner can register." register.schema.spec.ts only
// covers Zod validating the request shape — this covers the service actually creating the user.
describe("AuthService — register", () => {
  // No test in this codebase makes a live network call (same precedent as FakeStripeService) —
  // register() now calls isPasswordBreached() (ADR-032) for every registration, so every test in
  // this block needs fetch stubbed by default; the one test that specifically exercises a breach
  // overrides this locally.
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("") }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hashes the password before storing it and never persists the plaintext", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    let createdData:
      { email: string; displayName: string; passwordHash: string; locale: string } | undefined;
    const create = vi.fn().mockImplementation(({ data }) => {
      createdData = data;
      return Promise.resolve({
        id: "33333333-3333-3333-3333-333333333333",
        email: data.email,
        displayName: data.displayName,
        passwordHash: data.passwordHash,
        locale: data.locale,
      });
    });
    const findMany = vi.fn().mockResolvedValue([]);
    const fakePrisma = {
      user: { findUnique, create },
      membership: { findMany },
    } as unknown as PrismaService;
    const issueTokenPair = vi.fn().mockResolvedValue({ accessToken: "a", refreshToken: "r" });
    const fakeTokenService = { issueTokenPair } as unknown as TokenService;

    const authService = new AuthService(fakePrisma, fakeTokenService);
    const result = await authService.register({
      email: "new-owner@example.com",
      password: "SuperSecret123",
      displayName: "New Owner",
      locale: "en",
    });

    expect(createdData?.passwordHash).toBeDefined();
    expect(createdData?.passwordHash).not.toBe("SuperSecret123");
    expect(createdData?.passwordHash).toMatch(/^\$2[aby]\$/); // real bcrypt hash, not a copy
    expect(result.user).toEqual({
      id: "33333333-3333-3333-3333-333333333333",
      email: "new-owner@example.com",
      locale: "en",
    });
    // DATABASE.md, User Rules: "A User with zero Memberships is valid" — a freshly registered
    // User genuinely has none yet, and the same unconditional query correctly returns [] here
    // with no special-casing (see toAuthResult's own doc comment).
    expect(result.memberships).toEqual([]);
    expect(issueTokenPair).toHaveBeenCalledWith("33333333-3333-3333-3333-333333333333");
  });

  it("rejects registering an email that's already taken, without creating a second user", async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: "existing-id", email: "taken@example.com" });
    const create = vi.fn();
    const fakePrisma = { user: { findUnique, create } } as unknown as PrismaService;
    const fakeTokenService = { issueTokenPair: vi.fn() } as unknown as TokenService;

    const authService = new AuthService(fakePrisma, fakeTokenService);

    let caught: unknown;
    try {
      await authService.register({
        email: "taken@example.com",
        password: "whatever123",
        displayName: "Taken User",
        locale: "en",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppException);
    expect((caught as AppException).getStatus()).toBe(409);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects registration with a known-breached password, without creating a user", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const create = vi.fn();
    const fakePrisma = { user: { findUnique, create } } as unknown as PrismaService;
    const fakeTokenService = { issueTokenPair: vi.fn() } as unknown as TokenService;
    // Overrides the beforeEach's default "not breached" stub. "password" -> SHA-1
    // 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8 (prefix 5BAA6, real fixture, matches
    // hibp.util.spec.ts's own).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve("1E4C9B93F3F0682250B6CF8331B7EE68FD8:3730471"),
      }),
    );

    const authService = new AuthService(fakePrisma, fakeTokenService);

    let caught: unknown;
    try {
      await authService.register({
        email: "new-owner@example.com",
        password: "password",
        displayName: "New Owner",
        locale: "en",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppException);
    expect((caught as AppException).code).toBe("PASSWORD_BREACHED");
    expect(create).not.toHaveBeenCalled();
  });
});
