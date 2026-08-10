import { Injectable } from "@nestjs/common";
import type { User } from "@prisma/client";
import { AppException } from "../common/exceptions/app.exception";
import { PrismaService } from "../prisma/prisma.service";
import type { LoginDto } from "./dto/login.schema";
import type { RegisterDto } from "./dto/register.schema";
import { hashPassword, verifyPassword } from "./password.util";
import {
  RefreshTokenReuseDetectedError,
  TokenService,
  type RefreshTokenPayload,
  type TokenPair,
} from "./token.service";

export interface AuthResultMembership {
  id: string;
  organizationId: string;
  restaurantId: string | null;
  role: { id: string; name: string; permissions: string[] };
}

export interface AuthResult {
  id: string; // mirrors user.id — lets AuditLogInterceptor (Sprint 1) attribute the event without special-casing auth
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    locale: string;
  };
  // API_Contract.md, Login: "returns Access Token, Refresh Token, User, Memberships" — always
  // fetched fresh (same query shape as JwtAuthGuard, never trusted from a cached/stale view),
  // never special-cased per caller: a freshly registered User simply has none yet (DATABASE.md,
  // "a User with zero Memberships is valid"), so the same query correctly returns [] there too.
  memberships: AuthResultMembership[];
}

/** IP/user-agent for the security-event audit write in verifyRefreshTokenAndAudit — optional
 * since not every caller (e.g. a future internal/service-to-service refresh) has an HTTP
 * request to read them from. */
export interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResult> {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      // Deliberately vague — confirming an email exists is an enumeration leak (CLAUDE.md,
      // Think Like A Security Engineer).
      throw new AppException("VALIDATION_ERROR", "Unable to register with these details.", 409);
    }

    const passwordHash = await hashPassword(dto.password);
    const user = await this.prisma.user.create({
      data: { email: dto.email, passwordHash, locale: dto.locale },
    });

    const tokens = await this.tokenService.issueTokenPair(user.id);
    return await this.toAuthResult(user, tokens);
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user || user.deletedAt) {
      throw new AppException("AUTH_INVALID", "Invalid email or password.", 401);
    }
    if (user.status !== "ACTIVE") {
      throw new AppException("AUTH_INVALID", "Account is not active.", 401);
    }

    const valid = await verifyPassword(dto.password, user.passwordHash);
    if (!valid) {
      throw new AppException("AUTH_INVALID", "Invalid email or password.", 401);
    }

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } });

    const tokens = await this.tokenService.issueTokenPair(user.id);
    return await this.toAuthResult(user, tokens);
  }

  async refresh(refreshToken: string, context: RequestContext = {}): Promise<AuthResult> {
    const payload = await this.verifyRefreshTokenAndAudit(refreshToken, context);

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.deletedAt || user.status !== "ACTIVE") {
      throw new AppException("AUTH_INVALID", "Account is not active.", 401);
    }

    // Rotate: the old refresh token is revoked the moment a new pair is issued, so a leaked
    // refresh token that gets used once is worthless afterward. The new token carries the SAME
    // familyId forward — this is what lets TokenService detect a later replay of this exact
    // (now-superseded) token as reuse and revoke the whole family, not just reject one request.
    await this.revokeToken(refreshToken, payload.jti);

    const tokens = await this.tokenService.issueTokenPair(user.id, payload.familyId);
    return await this.toAuthResult(user, tokens);
  }

  async logout(refreshToken: string, context: RequestContext = {}): Promise<{ id: string }> {
    const payload = await this.verifyRefreshTokenAndAudit(refreshToken, context);
    await this.revokeToken(refreshToken, payload.jti);
    return { id: payload.sub };
  }

  /** Wraps TokenService.verifyRefreshToken to catch the reuse-detection signal specifically and
   * write it to AuditLog as its own action, `refresh_token_reuse_detected` — CLAUDE_RULES.md,
   * Logging Philosophy: "Always log: ... Security Events." Bypasses AuditLogInterceptor
   * (Sprint 1) on purpose: that interceptor only fires on a *successful* mutation response, and
   * this is, definitionally, a request that's about to fail with 401 — there is no success path
   * for it to hook into. Re-throws the same error afterward so client-facing behavior (401,
   * AUTH_INVALID) is unchanged either way. */
  private async verifyRefreshTokenAndAudit(
    refreshToken: string,
    context: RequestContext,
  ): Promise<RefreshTokenPayload> {
    try {
      return await this.tokenService.verifyRefreshToken(refreshToken);
    } catch (err) {
      if (err instanceof RefreshTokenReuseDetectedError) {
        await this.prisma.auditLog.create({
          data: {
            userId: err.userId,
            entity: "Authentication",
            entityId: err.userId,
            action: "refresh_token_reuse_detected",
            metadata: { familyId: err.familyId },
            ipAddress: context.ipAddress ?? null,
            userAgent: context.userAgent ?? null,
          },
        });
      }
      throw err;
    }
  }

  private async revokeToken(token: string, jti: string): Promise<void> {
    const decoded = this.decodeExpiry(token);
    const remainingSeconds = decoded ? Math.max(0, decoded - Math.floor(Date.now() / 1000)) : 0;
    await this.tokenService.revoke(jti, remainingSeconds);
  }

  private decodeExpiry(token: string): number | null {
    try {
      const payloadSegment = token.split(".")[1];
      const decoded = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
      return typeof decoded.exp === "number" ? decoded.exp : null;
    } catch {
      return null;
    }
  }

  // Same query shape as JwtAuthGuard's own — deliberately not read from `user` itself (a plain
  // Prisma User row never carries memberships unless explicitly included), and always queried
  // fresh rather than passed in by the caller, so register/login/refresh can't drift out of sync
  // with each other on what "the current Memberships" means.
  private async toAuthResult(user: User, tokens: TokenPair): Promise<AuthResult> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId: user.id },
      include: { role: { include: { rolePermissions: { include: { permission: true } } } } },
    });

    return {
      id: user.id,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: { id: user.id, email: user.email, locale: user.locale },
      memberships: memberships.map((m) => ({
        id: m.id,
        organizationId: m.organizationId,
        restaurantId: m.restaurantId,
        role: {
          id: m.role.id,
          name: m.role.name,
          permissions: m.role.rolePermissions.map((rp) => rp.permission.name),
        },
      })),
    };
  }
}
