import { JwtService } from "@nestjs/jwt";
import { beforeEach, describe, expect, it } from "vitest";
import { TokenService } from "./token.service";
import type { RedisService } from "../redis/redis.service";
import { AppException } from "../common/exceptions/app.exception";

/** In-memory fake standing in for Redis — enough surface (`get`/`set`) for TokenService's
 * revocation checks, without a real Redis connection. */
class FakeRedisClient {
  private readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  // Signature matches ioredis's `set(key, value, "EX", seconds)` overload used by TokenService.
  async set(key: string, value: string, _mode: "EX", _seconds: number): Promise<"OK"> {
    this.store.set(key, value);
    return "OK";
  }
}

function fakeRedisService(): RedisService {
  const client = new FakeRedisClient();
  return { getClient: () => client } as unknown as RedisService;
}

function fakeConfigService(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    JWT_ACCESS_SECRET: "test-access-secret-at-least-32-characters-long",
    JWT_REFRESH_SECRET: "test-refresh-secret-at-least-32-characters-long",
    JWT_ACCESS_TTL_SECONDS: 900,
    JWT_REFRESH_TTL_SECONDS: 604_800,
    ...overrides,
  };
  return {
    getOrThrow: (key: string) => values[key],
    get: (key: string, fallback?: unknown) => values[key] ?? fallback,
  } as never;
}

describe("TokenService", () => {
  let service: TokenService;
  const userId = "11111111-1111-1111-1111-111111111111";

  beforeEach(() => {
    service = new TokenService(new JwtService(), fakeRedisService(), fakeConfigService());
  });

  it("issues an access token and a refresh token that verify as their own type", async () => {
    const { accessToken, refreshToken } = await service.issueTokenPair(userId);

    const access = await service.verifyAccessToken(accessToken);
    expect(access.sub).toBe(userId);
    expect(access.type).toBe("access");

    const refresh = await service.verifyRefreshToken(refreshToken);
    expect(refresh.sub).toBe(userId);
    expect(refresh.type).toBe("refresh");
  });

  // The real risk this test guards against: signing both tokens with distinguishable payloads
  // but forgetting to actually check `type` on verification, which would let a refresh token be
  // used to authenticate a normal request (a longer-lived credential doing a short-lived
  // credential's job).
  it("rejects a refresh token presented as an access token", async () => {
    const { refreshToken } = await service.issueTokenPair(userId);
    await expect(service.verifyAccessToken(refreshToken)).rejects.toThrow(AppException);
  });

  it("rejects an access token presented as a refresh token", async () => {
    const { accessToken } = await service.issueTokenPair(userId);
    await expect(service.verifyRefreshToken(accessToken)).rejects.toThrow(AppException);
  });

  it("rejects a token signed with the wrong secret, as AUTH_INVALID (not AUTH_EXPIRED)", async () => {
    const otherService = new TokenService(
      new JwtService(),
      fakeRedisService(),
      fakeConfigService({ JWT_ACCESS_SECRET: "a-completely-different-secret-32-characters-plus" }),
    );
    const { accessToken } = await otherService.issueTokenPair(userId);

    await expect(service.verifyAccessToken(accessToken)).rejects.toMatchObject({
      code: "AUTH_INVALID",
    });
  });

  // Distinguishing these matters to a real client: AUTH_EXPIRED means "call /auth/refresh",
  // AUTH_INVALID means "this token was never going to work — re-login." Collapsing both into one
  // generic code (the first draft did) would tell a well-behaved client to retry a refresh that
  // can never succeed.
  it("reports a naturally expired token as AUTH_EXPIRED specifically", async () => {
    const rawJwt = new JwtService();
    const expiredToken = await rawJwt.signAsync(
      { sub: userId, jti: "expired-jti", type: "access" },
      { secret: "test-access-secret-at-least-32-characters-long", expiresIn: -10 },
    );

    await expect(service.verifyAccessToken(expiredToken)).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
    });
  });

  it("rejects a revoked refresh token even though its signature and expiry are still valid", async () => {
    const { refreshToken } = await service.issueTokenPair(userId);
    const { jti } = await service.verifyRefreshToken(refreshToken);

    await service.revoke(jti, 3600);

    await expect(service.verifyRefreshToken(refreshToken)).rejects.toThrow(AppException);
  });

  it("does not revoke a token it was never told to revoke", async () => {
    const { refreshToken } = await service.issueTokenPair(userId);
    // Revoking some unrelated jti must not affect this token.
    await service.revoke("some-other-jti", 3600);

    await expect(service.verifyRefreshToken(refreshToken)).resolves.toMatchObject({
      sub: userId,
    });
  });
});
