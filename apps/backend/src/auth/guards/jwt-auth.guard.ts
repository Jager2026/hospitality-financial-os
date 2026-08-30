import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { AppException } from "../../common/exceptions/app.exception";
import { PrismaService } from "../../prisma/prisma.service";
import { ACTIVE_MEMBERSHIP_WHERE, MEMBERSHIP_ROLE_INCLUDE } from "../active-memberships";
import { TokenService } from "../token.service";

export interface AuthenticatedUser {
  id: string;
  email: string;
  locale: string;
  memberships: Array<{
    id: string;
    organizationId: string;
    restaurantId: string | null;
    role: { id: string; name: string; permissions: string[] };
  }>;
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}

/** Verifies the Bearer access token and attaches the current User (with Memberships + Role) to
 * `request.user`. Fetches fresh from the database on every request rather than trusting the JWT
 * payload for anything beyond identity — Memberships can change between requests (a new
 * invitation, a disabled Membership) and a stale cached grant is a security bug, not a
 * performance shortcut worth taking without measuring first (CLAUDE.md, Performance Rules). */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokenService: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractBearerToken(request);
    if (!token) {
      throw new AppException("AUTH_INVALID", "Missing or malformed Authorization header.", 401);
    }

    const payload = await this.tokenService.verifyAccessToken(token);

    // The `where` is the whole point and is not decoration: without it a Membership set to
    // INACTIVE by `PATCH /memberships/{id}/disable` still arrived here with its Role and every
    // permission attached, and nothing downstream could tell — `AuthenticatedUser` carries no
    // status field. See `active-memberships.ts`.
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        memberships: { where: ACTIVE_MEMBERSHIP_WHERE, include: MEMBERSHIP_ROLE_INCLUDE },
      },
    });

    if (!user || user.deletedAt || user.status !== "ACTIVE") {
      throw new AppException("AUTH_INVALID", "Account is not active.", 401);
    }

    request.user = {
      id: user.id,
      email: user.email,
      locale: user.locale,
      memberships: user.memberships.map((m) => ({
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

    return true;
  }

  private extractBearerToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) return null;
    return header.slice("Bearer ".length).trim() || null;
  }
}
