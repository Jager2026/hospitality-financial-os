import { Injectable } from "@nestjs/common";
import type { Membership, MembershipInvitation } from "@prisma/client";
import { hashPassword } from "../auth/password.util";
import { AppException } from "../common/exceptions/app.exception";
import { PrismaService } from "../prisma/prisma.service";
import type { AcceptInvitationDto } from "./dto/accept-invitation.schema";
import type { InviteMembershipDto } from "./dto/invite-membership.schema";
import {
  generateInvitationToken,
  hashInvitationToken,
  verifyInvitationToken,
} from "./invitation-token.util";

// Mirrors JWT_REFRESH_TTL_SECONDS's own default (7 days) — long enough for someone to check their
// email and act, no reason to invent a different number for a conceptually similar TTL.
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface InvitationCreated {
  id: string;
  email: string;
  /** Exists exactly once, here — never persisted (ADR-020). The caller is responsible for
   * relaying it (email, Slack, whatever) until a real delivery provider exists with its own ADR. */
  token: string;
}

@Injectable()
export class MembershipInvitationService {
  constructor(private readonly prisma: PrismaService) {}

  /** ADR-020: creates a MembershipInvitation, never a Membership directly — true even when
   * `email` already belongs to an existing User. `organizationId` is the caller's own org
   * (resolved by the controller from the inviter's Membership, matching restaurant.service.ts's
   * own convention of never trusting a client-supplied organizationId). */
  async invite(
    dto: InviteMembershipDto,
    organizationId: string,
    invitedByUserId: string,
  ): Promise<InvitationCreated> {
    const role = await this.prisma.role.findUnique({ where: { id: dto.roleId } });
    if (!role) {
      throw new AppException("VALIDATION_ERROR", "Role not found.", 400);
    }

    if (dto.restaurantId) {
      const restaurant = await this.prisma.restaurant.findFirst({
        where: { id: dto.restaurantId, organizationId, deletedAt: null },
      });
      if (!restaurant) {
        throw new AppException("RESTAURANT_NOT_FOUND", "Restaurant not found.", 404);
      }
    }

    const token = generateInvitationToken();
    const tokenHash = hashInvitationToken(token);

    const invitation = await this.prisma.membershipInvitation.create({
      data: {
        email: dto.email,
        organizationId,
        restaurantId: dto.restaurantId ?? null,
        roleId: dto.roleId,
        invitedBy: invitedByUserId,
        tokenHash,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      },
    });

    return { id: invitation.id, email: invitation.email, token };
  }

  /** ADR-020: looks up candidates by email (non-secret), hash-verifies the token against each —
   * same shape as a password check, never a lookup keyed on the token itself. Creates User (only
   * if none exists for this email) and Membership together, atomically. Does not issue tokens —
   * MASTERPLAN.md's own user journey has "Creates Password" and "Logs In" as separate steps; the
   * existing POST /auth/login is what proves the resulting account actually works. */
  async accept(dto: AcceptInvitationDto): Promise<Membership> {
    const invitation = await this.findMatchingInvitation(dto.email, dto.token);

    let user = await this.prisma.user.findUnique({ where: { email: dto.email } });

    if (!user) {
      if (!dto.password) {
        throw new AppException(
          "VALIDATION_ERROR",
          "Password is required to accept this invitation.",
          400,
        );
      }
      const passwordHash = await hashPassword(dto.password);
      user = await this.prisma.user.create({
        data: { email: dto.email, passwordHash, locale: "en" },
      });
    }

    const [membership] = await this.prisma.$transaction([
      this.prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: invitation.organizationId,
          restaurantId: invitation.restaurantId,
          roleId: invitation.roleId,
          status: "ACTIVE",
        },
      }),
      this.prisma.membershipInvitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      }),
    ]);

    return membership;
  }

  private async findMatchingInvitation(
    email: string,
    token: string,
  ): Promise<MembershipInvitation> {
    const candidates = await this.prisma.membershipInvitation.findMany({
      where: { email, acceptedAt: null, expiresAt: { gt: new Date() } },
    });

    for (const candidate of candidates) {
      if (verifyInvitationToken(token, candidate.tokenHash)) {
        return candidate;
      }
    }

    // Deliberately vague — same reasoning as AuthService.login()'s "Invalid email or password":
    // distinguishing "no invitation for this email" from "wrong token" is an enumeration leak.
    throw new AppException("INVITATION_INVALID", "Invalid or expired invitation.", 400);
  }
}
