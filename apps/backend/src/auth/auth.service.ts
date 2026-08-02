import { Injectable } from "@nestjs/common";
import type { User } from "@prisma/client";
import { AppException } from "../common/exceptions/app.exception";
import { PrismaService } from "../prisma/prisma.service";
import type { LoginDto } from "./dto/login.schema";
import type { RegisterDto } from "./dto/register.schema";
import { hashPassword, verifyPassword } from "./password.util";
import { TokenService, type TokenPair } from "./token.service";

export interface AuthResult {
  id: string; // mirrors user.id — lets AuditLogInterceptor (Sprint 1) attribute the event without special-casing auth
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    locale: string;
  };
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
    return this.toAuthResult(user, tokens);
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
    return this.toAuthResult(user, tokens);
  }

  async refresh(refreshToken: string): Promise<AuthResult> {
    const payload = await this.tokenService.verifyRefreshToken(refreshToken);

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.deletedAt || user.status !== "ACTIVE") {
      throw new AppException("AUTH_INVALID", "Account is not active.", 401);
    }

    // Rotate: the old refresh token is revoked the moment a new pair is issued, so a leaked
    // refresh token that gets used once is worthless afterward.
    await this.revokeToken(refreshToken, payload.jti);

    const tokens = await this.tokenService.issueTokenPair(user.id);
    return this.toAuthResult(user, tokens);
  }

  async logout(refreshToken: string): Promise<{ id: string }> {
    const payload = await this.tokenService.verifyRefreshToken(refreshToken);
    await this.revokeToken(refreshToken, payload.jti);
    return { id: payload.sub };
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

  private toAuthResult(user: User, tokens: TokenPair): AuthResult {
    return {
      id: user.id,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: { id: user.id, email: user.email, locale: user.locale },
    };
  }
}
