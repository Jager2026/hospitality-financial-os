import { describe, expect, it, vi } from "vitest";
import { AuthService } from "./auth.service";
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
