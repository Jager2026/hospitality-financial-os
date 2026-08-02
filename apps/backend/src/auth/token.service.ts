import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { RedisService } from "../redis/redis.service";
import { AppException } from "../common/exceptions/app.exception";

export interface AccessTokenPayload {
  sub: string; // user id
  jti: string;
  type: "access";
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
  familyId: string;
  type: "refresh";
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/** Thrown specifically at the moment reuse is *detected* — the first request to replay an
 * already-rotated-out token, the one that actually triggers family revocation — as opposed to
 * every subsequent request against that same already-revoked family, which gets the plain
 * AppException below. CLAUDE_RULES.md, Logging Philosophy: "Always log: ... Security Events" —
 * this is that event, and the caller needs a way to tell it apart from an ordinary auth failure
 * in order to log it as one (see AuthService, action `refresh_token_reuse_detected`).
 *
 * Extends AppException on purpose: even if a future call site forgets to catch this specifically,
 * it still produces the correct 401 to the client by default — only the audit entry is missed,
 * not the security response itself. */
export class RefreshTokenReuseDetectedError extends AppException {
  constructor(
    public readonly userId: string,
    public readonly familyId: string,
  ) {
    super("AUTH_INVALID", "Refresh token has been revoked.", 401);
    this.name = "RefreshTokenReuseDetectedError";
  }
}

const REVOKED_JTI_PREFIX = "auth:revoked-jti:";
const REVOKED_FAMILY_PREFIX = "auth:revoked-family:";

/**
 * ADR/DATABASE.md gap, flagged not hidden: DATABASE.md's Core Domain has no RefreshToken entity
 * (unlike the 20 entities it does enumerate) — Withdrawal-style entities excluded from MVP are
 * always named explicitly under "Future Entities"; this one simply isn't mentioned either way.
 * Read as an oversight, not a deliberate exclusion, since API_Contract.md and
 * IMPLEMENTATION_PLAN.md Sprint 2 both name "Refresh Token" as real, in-scope functionality.
 *
 * Chosen design: refresh tokens are stateless signed JWTs (no new Postgres table — nothing here
 * needs DATABASE.md's Soft Deletes / immutability rules, since a refresh token isn't a financial
 * or business fact, just a bearer credential). Revocation (logout, and rotation-on-refresh) is
 * tracked in Redis by jti with a TTL matching the token's own remaining lifetime — Redis is
 * already part of the stack (Sprint 1) and this is exactly the kind of short-lived, non-financial
 * state it's meant for, unlike Wallet/Restaurant balance which must never live only in Redis
 * (SYSTEM_ARCHITECTURE.md, Caching Strategy). Flagging this design choice explicitly for the
 * Founder to confirm or override, same as the enum/status assumptions in Sprint 0-1.
 *
 * REUSE DETECTION: every refresh token carries a `familyId` — generated once at login/register,
 * and carried forward unchanged across every rotation descended from that login. Presenting a
 * refresh token whose *individual* jti is already revoked (i.e., it was already rotated away
 * once) is not just "an expired credential" — replaying an already-superseded token is the
 * textbook signature of a stolen token racing the legitimate client. The correct response is not
 * "reject this one request," it's "assume the whole family may be compromised": the entire
 * family is revoked, which invalidates the *current, still-valid* token too, forcing the
 * legitimate user to re-authenticate. A weaker implementation that only rejects the replayed
 * token leaves the legitimate session (and, if it really was theft, the attacker's stolen current
 * token) both still valid — this is exactly that gap, closed.
 */
@Injectable()
export class TokenService {
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;

  constructor(
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.accessSecret = config.getOrThrow<string>("JWT_ACCESS_SECRET");
    this.refreshSecret = config.getOrThrow<string>("JWT_REFRESH_SECRET");
    this.accessTtlSeconds = config.get<number>("JWT_ACCESS_TTL_SECONDS", 900);
    this.refreshTtlSeconds = config.get<number>("JWT_REFRESH_TTL_SECONDS", 604_800);
  }

  /** `familyId`: omit on a fresh login/register (starts a new family); pass the family of the
   * token being rotated on `/auth/refresh` (extends the same family — see class doc). */
  async issueTokenPair(userId: string, familyId: string = randomUUID()): Promise<TokenPair> {
    const accessToken = await this.jwt.signAsync(
      { sub: userId, jti: randomUUID(), type: "access" } satisfies AccessTokenPayload,
      { secret: this.accessSecret, expiresIn: this.accessTtlSeconds },
    );
    const refreshToken = await this.jwt.signAsync(
      { sub: userId, jti: randomUUID(), familyId, type: "refresh" } satisfies RefreshTokenPayload,
      { secret: this.refreshSecret, expiresIn: this.refreshTtlSeconds },
    );
    return { accessToken, refreshToken };
  }

  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    const payload = await this.verify<AccessTokenPayload>(token, this.accessSecret);
    if (payload.type !== "access") {
      throw new AppException("AUTH_INVALID", "Not an access token.", 401);
    }
    if (await this.isJtiRevoked(payload.jti)) {
      throw new AppException("AUTH_INVALID", "Token has been revoked.", 401);
    }
    return payload;
  }

  async verifyRefreshToken(token: string): Promise<RefreshTokenPayload> {
    const payload = await this.verify<RefreshTokenPayload>(token, this.refreshSecret);
    if (payload.type !== "refresh") {
      throw new AppException("AUTH_INVALID", "Not a refresh token.", 401);
    }

    if (await this.isFamilyRevoked(payload.familyId)) {
      throw new AppException("AUTH_INVALID", "Refresh token has been revoked.", 401);
    }

    if (await this.isJtiRevoked(payload.jti)) {
      // This exact token was already rotated away once — a replay, not a fresh use. Revoke the
      // whole family so the token this replay is racing against also stops working, and signal
      // this specific request as the detection event (distinct from the isFamilyRevoked check
      // above, which fires for every *subsequent* request once the family is already revoked).
      await this.revokeFamily(payload.familyId, this.refreshTtlSeconds);
      throw new RefreshTokenReuseDetectedError(payload.sub, payload.familyId);
    }

    return payload;
  }

  /** Revokes one token's jti — used for the routine "rotate the old token out" step on every
   * successful `/auth/refresh`, and for `/auth/logout`. `expSeconds` is the token's own remaining
   * lifetime, so the Redis key expires at the same moment the JWT itself would have expired
   * naturally — never revoked-forever bookkeeping for a token that's already unusable anyway. */
  async revoke(jti: string, expSeconds: number): Promise<void> {
    if (expSeconds <= 0) return;
    await this.redis.getClient().set(`${REVOKED_JTI_PREFIX}${jti}`, "1", "EX", expSeconds);
  }

  /** Revokes every token descended from one login, present or future — the reuse-detection
   * response. `expSeconds` should be at least the full refresh TTL: a family flag that expired
   * before the newest token in the family does would let that token work again once the flag
   * lapsed, defeating the point. */
  async revokeFamily(familyId: string, expSeconds: number): Promise<void> {
    if (expSeconds <= 0) return;
    await this.redis.getClient().set(`${REVOKED_FAMILY_PREFIX}${familyId}`, "1", "EX", expSeconds);
  }

  private async isJtiRevoked(jti: string): Promise<boolean> {
    const value = await this.redis.getClient().get(`${REVOKED_JTI_PREFIX}${jti}`);
    return value !== null;
  }

  private async isFamilyRevoked(familyId: string): Promise<boolean> {
    const value = await this.redis.getClient().get(`${REVOKED_FAMILY_PREFIX}${familyId}`);
    return value !== null;
  }

  private async verify<T extends object>(token: string, secret: string): Promise<T> {
    try {
      return await this.jwt.verifyAsync<T>(token, { secret });
    } catch (err) {
      // jsonwebtoken (wrapped by @nestjs/jwt) throws TokenExpiredError specifically for an
      // otherwise-valid, naturally-expired token — everything else (bad signature, malformed,
      // wrong secret) is a different failure mode a client should react to differently (re-login,
      // not just refresh). Distinguished by name rather than importing jsonwebtoken directly,
      // since @nestjs/jwt re-exports the same error classes without its own wrapper types.
      if (err instanceof Error && err.name === "TokenExpiredError") {
        throw new AppException("AUTH_EXPIRED", "Token has expired.", 401);
      }
      throw new AppException("AUTH_INVALID", "Token is invalid.", 401);
    }
  }
}
