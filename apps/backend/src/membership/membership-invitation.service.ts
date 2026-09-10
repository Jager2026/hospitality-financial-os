import { Injectable } from "@nestjs/common";
import type { Membership, MembershipInvitation } from "@prisma/client";
import type { RequestContext } from "../auth/auth.service";
import { isPasswordBreached } from "../auth/hibp.util";
import { hashPassword } from "../auth/password.util";
import { ConfigService } from "@nestjs/config";
import { CURRENT_PLATFORM_TERMS_VERSION } from "../common/agreements/agreement-versions";
import { AppException } from "../common/exceptions/app.exception";
import { EmailOutboxService } from "../email/email-outbox.service";
import { DEFAULT_EMAIL_LOCALE, invitationEmail } from "../email/email-copy";
import { PrismaService } from "../prisma/prisma.service";
import { createUserAccount } from "../user/create-user-account";
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
}

@Injectable()
export class MembershipInvitationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emailOutbox: EmailOutboxService,
    private readonly config: ConfigService,
  ) {}

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
    // ADR-044, the enforcing half of the rule. `GET /roles` already omits platform-only Roles, and
    // stopping there would be worse than doing nothing visible at all: the dropdown would look
    // correct while a direct API call still granted "Administrator" — every Permission — to
    // anyone an Owner chose. A filtered interface over an endpoint that accepts everything is
    // exactly the failure ADR-031 records, where the response looks like success.
    //
    // Answered as "not found" rather than "forbidden", deliberately: to a Restaurant this Role
    // does not exist, and saying "you may not grant that one" would confirm it does and invite
    // someone to go looking for a way.
    if (role.platformOnly) {
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
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

    const [inviter, place] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: invitedByUserId },
        select: { displayName: true },
      }),
      this.placeName(organizationId, dto.restaurantId ?? null),
    ]);

    const { subject, text } = invitationEmail(DEFAULT_EMAIL_LOCALE, {
      inviterName: inviter.displayName,
      placeName: place,
      roleName: role.name,
      acceptUrl: this.acceptUrl(dto.email, token),
      expiresInDays: INVITATION_TTL_MS / (24 * 60 * 60 * 1000),
    });

    // ONE TRANSACTION, and that is the whole point of routing this through the Outbox. An
    // invitation that exists without a queued email is a person waiting for a message nobody will
    // ever send; a queued email without an invitation is a link that cannot be accepted. Neither
    // half can commit alone.
    const invitation = await this.prisma.$transaction(async (tx) => {
      const created = await tx.membershipInvitation.create({
        data: {
          email: dto.email,
          organizationId,
          restaurantId: dto.restaurantId ?? null,
          roleId: dto.roleId,
          invitedBy: invitedByUserId,
          tokenHash,
          expiresAt,
        },
      });
      await this.emailOutbox.enqueue(tx, { to: dto.email, subject, text });
      return created;
    });

    // THE TOKEN IS NOT RETURNED, and its absence is asserted by a test.
    //
    // It used to be, because there was nowhere else for it to go (ADR-020). Now there is. Leaving
    // it in both places would mean the email path is never the one anybody exercises: the console
    // would keep working, the message could stop arriving, and nothing would say so. A path that
    // is not the only path is a path that is not really tested.
    return { id: invitation.id, email: invitation.email };
  }

  /**
   * Where the invitee is being invited: the Restaurant when the invitation is scoped to one, the
   * Organization when it is org-wide. **A name, not an id** — the recipient has no account and no
   * way to look one up, and "you have been invited to 3fa85f64-…" is not an invitation.
   */
  private async placeName(organizationId: string, restaurantId: string | null): Promise<string> {
    if (restaurantId) {
      const restaurant = await this.prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { name: true },
      });
      if (restaurant) return restaurant.name;
    }
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { name: true },
    });
    return org.name;
  }

  /**
   * The link in the email.
   *
   * `FRONTEND_URL` is validated at boot and is refused in production when it points at a loopback
   * address (ADR-045) — a rule written for Stripe's onboarding return_url, and now load-bearing for
   * a second reason: a localhost link in an invitation is a link that works for nobody.
   *
   * The email is carried alongside the token because `accept` looks candidates up by email and
   * hash-verifies the token against each (ADR-020), rather than keying a lookup on the secret.
   */
  private acceptUrl(email: string, token: string): string {
    const base = this.config.getOrThrow<string>("FRONTEND_URL").replace(/\/+$/, "");
    const params = new URLSearchParams({ email, token });
    return `${base}/invitations/accept?${params.toString()}`;
  }

  /** ADR-020: looks up candidates by email (non-secret), hash-verifies the token against each —
   * same shape as a password check, never a lookup keyed on the token itself. Creates User (only
   * if none exists for this email) and Membership together, atomically. Does not issue tokens —
   * MASTERPLAN.md's own user journey has "Creates Password" and "Logs In" as separate steps; the
   * existing POST /auth/login is what proves the resulting account actually works. */
  async accept(dto: AcceptInvitationDto, context?: RequestContext): Promise<Membership> {
    const invitation = await this.findMatchingInvitation(dto.email, dto.token);

    // ADR-044, defence in depth on a permission grant. invite() already rejects a platform-only
    // Role, so an invitation carrying one can only exist if it predates that check. None do — but
    // the alternative to this line is reasoning about the vintage of a row every time someone
    // reads this method, and the grant it authorises is every Permission in the system.
    const invitedRole = await this.prisma.role.findUnique({ where: { id: invitation.roleId } });
    if (invitedRole?.platformOnly) {
      throw new AppException("VALIDATION_ERROR", "Invitation is no longer valid.", 400);
    }

    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });

    /**
     * The consent this path used to skip (ADR-049).
     *
     * **Accepting an invitation is the SECOND way a `User` is created**, and until now it was the
     * one that wrote no `AgreementAcceptance`. Registration has written one since ADR-049; this
     * did not, so every person who joined through an invitation was using the platform with no
     * record of having agreed to anything. `AuthService.register`'s own comment names that gap as
     * the thing it closes — it was closed on one path and left open on the other.
     *
     * **It could not be repaired afterwards, and that is why it waited for this screen rather than
     * for a migration.** A row written later asserts that a person agreed at a moment when nobody
     * asked them. The trigger recorded for it was "before the first venue onboards staff", and the
     * acceptance screen is that moment: before it existed there was nowhere to put the question.
     *
     * Required only when this request creates the User. Somebody who already has an account
     * accepted the terms when they registered, and a second row would claim they agreed twice.
     */
    let acceptedVersion: string | null = null;
    if (!existing) {
      if (!dto.password) {
        throw new AppException(
          "VALIDATION_ERROR",
          "Password is required to accept this invitation.",
          400,
        );
      }
      if (!dto.displayName) {
        throw new AppException(
          "VALIDATION_ERROR",
          "Display name is required to accept this invitation.",
          400,
        );
      }
      if (!dto.acceptedTermsVersion) {
        throw new AppException(
          "VALIDATION_ERROR",
          "Accepting the terms is required to create an account from this invitation.",
          400,
        );
      }
      if (await isPasswordBreached(dto.password)) {
        throw new AppException(
          "PASSWORD_BREACHED",
          "This password has appeared in a known data breach. Please choose a different one.",
          400,
        );
      }
      // Checked against the server's own value rather than trusted, exactly as registration does:
      // a client could otherwise record agreement to any string, and a stale tab would record
      // agreement to a revision that has since changed. Rejected rather than silently corrected —
      // correcting it would write down that the person accepted something they were never shown.
      //
      // Ordered after the breached-password check to match `AuthService.register` step for step.
      // The order is observable — it decides which of two errors a caller sees when both apply —
      // and two paths creating the same kind of record should not answer differently.
      if (dto.acceptedTermsVersion !== CURRENT_PLATFORM_TERMS_VERSION) {
        throw new AppException(
          "TERMS_VERSION_MISMATCH",
          "The terms have changed since this page was opened. Please reload and read them again.",
          409,
        );
      }
      acceptedVersion = dto.acceptedTermsVersion;
    }

    const passwordHash =
      existing === null && dto.password !== undefined ? await hashPassword(dto.password) : null;

    /**
     * One transaction for all four writes, and the User moved inside it.
     *
     * It used to be created on its own, before a separate `$transaction` holding the Membership and
     * the invitation update — so a failure in that transaction left a `User` row with no Membership
     * and no way back in: the invitation is still unaccepted, but the second attempt takes the
     * "already has an account" branch and never asks for a password again. Adding the acceptance
     * made this unavoidable rather than merely untidy, because a `User` that exists without its
     * acceptance is the exact gap being closed here.
     *
     * **Not covered by a test, and that is stated rather than glossed.** Forcing a failure between
     * these writes needs a lever the schema does not offer: the Role and Organization cannot be
     * deleted out from under an invitation (`RESTRICT` foreign keys refuse it — measured, not
     * assumed), `AgreementAcceptance` has no length-bounded column to overflow, and the remaining
     * options are mocks that would test the mock. The tests below prove that the pre-transaction
     * refusals leave nothing behind; the atomicity of the four writes rests on `$transaction`
     * itself.
     */
    return await this.prisma.$transaction(async (tx) => {
      const user =
        existing ??
        (await createUserAccount(tx, {
          email: dto.email,
          displayName: dto.displayName as string,
          passwordHash: passwordHash as string,
          locale: "en",
        }));

      if (acceptedVersion !== null) {
        await tx.agreementAcceptance.create({
          data: {
            agreement: "PLATFORM_TERMS",
            version: acceptedVersion,
            userId: user.id,
            ipAddress: context?.ipAddress ?? null,
            userAgent: context?.userAgent ?? null,
          },
        });
      }

      const membership = await tx.membership.create({
        data: {
          userId: user.id,
          organizationId: invitation.organizationId,
          restaurantId: invitation.restaurantId,
          roleId: invitation.roleId,
          status: "ACTIVE",
        },
      });

      await tx.membershipInvitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      });

      return membership;
    });
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
