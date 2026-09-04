import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AuditEntity } from "../common/decorators/audit-entity.decorator";
import { RequirePermission } from "../auth/decorators/require-permission.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard, type AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { PermissionsGuard } from "../auth/guards/permissions.guard";
import { AppException } from "../common/exceptions/app.exception";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PrismaService } from "../prisma/prisma.service";
import { acceptInvitationSchema, type AcceptInvitationDto } from "./dto/accept-invitation.schema";
import { inviteMembershipSchema, type InviteMembershipDto } from "./dto/invite-membership.schema";
import { updateMembershipSchema, type UpdateMembershipDto } from "./dto/update-membership.schema";
import { MembershipInvitationService } from "./membership-invitation.service";
import { MembershipService } from "./membership.service";

// API_Contract.md, MEMBERSHIPS. No controller-level prefix (unlike most controllers) — same
// reasoning as TipController: this controller owns both /memberships/... routes AND
// /restaurants/:id/staff (ADR-033), and NestJS has no way to escape a controller-level prefix
// per-route, so every method path is written out in full instead.
@Controller()
export class MembershipController {
  constructor(
    private readonly membershipService: MembershipService,
    private readonly invitationService: MembershipInvitationService,
    private readonly prisma: PrismaService,
  ) {}

  // Sprint 11 (ADR-028): 20/min. THE CONDITION THIS COMMENT SET HAS NOW BEEN MET, and it is
  // recorded here rather than quietly left behind: a real delivery provider exists (ADR-069), so
  // this endpoint is no longer only a resource-exhaustion vector against our own table — it now
  // sends real mail from a verified domain to any address the caller names.
  //
  // What that changes: 20/min is 1,200 messages an hour to arbitrary recipients, from
  // plaintabs.com. The cost of abuse is no longer rows in a table we own; it is our domain
  // reputation, which is shared by every future message and is slow to repair.
  //
  // THE NUMBER IS DELIBERATELY UNCHANGED HERE. How many staff a venue may onboard per minute is a
  // product decision about onboarding throughput, not an engineering one, and lowering it
  // unilaterally would silently narrow a real workflow. Flagged for the Founder in ADR-070; the
  // mechanism is right, only the value is open.
  @Post("memberships")
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission("membership.invite")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @AuditEntity("MembershipInvitation")
  async invite(
    @Body(new ZodValidationPipe(inviteMembershipSchema)) dto: InviteMembershipDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const organizationId = await this.resolveOrganizationId(dto, user);

    // PermissionsGuard's own check (above) is the fast global reject — "does this user have
    // membership.invite on ANY Membership." This is the resource-scoped second layer, same rule
    // as everywhere else (ADR-005): an org-wide Membership in this Organization can invite into
    // it or any of its Restaurants; a restaurant-scoped Membership (e.g. a Manager,
    // seed.ts) can only invite into that exact Restaurant, never org-wide and never a
    // different Restaurant.
    const canInvite = user.memberships.some((m) => {
      if (m.organizationId !== organizationId) return false;
      if (!m.role.permissions.includes("membership.invite")) return false;
      if (m.restaurantId === null) return true;
      return dto.restaurantId === m.restaurantId;
    });
    if (!canInvite) {
      throw new AppException(
        "PERMISSION_DENIED",
        "Missing required permission: membership.invite",
        403,
      );
    }

    return this.invitationService.invite(dto, organizationId, user.id);
  }

  // Public, deliberately no JwtAuthGuard: the invitee may not have an account yet
  // (API_Contract.md, Accept Invitation). The invitation token itself is the credential.
  // Same reasoning as AuthController's own override (API_Contract.md, Rate Limiting: "Public
  // low"): an unauthenticated endpoint that does a DB lookup by email plus a hash-compare per
  // candidate is the same cost/risk shape as a login attempt, so it gets the same 10/min rather
  // than the global 100/min baseline (ADR-010).
  @Post("memberships/invitations/accept")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  acceptInvitation(@Body(new ZodValidationPipe(acceptInvitationSchema)) dto: AcceptInvitationDto) {
    return this.invitationService.accept(dto);
  }

  @Get("memberships")
  @UseGuards(JwtAuthGuard)
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.membershipService.findAllForUser(user);
  }

  // ADR-033: the terminal's own "who actually served this table" picker — every Membership
  // reachable at this Restaurant (the same reachability rule as everywhere else, ADR-005), not
  // filtered to any one Role. Founder decision: "кто реально обслужил стол", not "у кого
  // RBAC-роль Waiter" — a Manager or Owner can be picked exactly like anyone else.
  @Get("restaurants/:id/staff")
  @UseGuards(JwtAuthGuard)
  findStaffForRestaurant(
    @Param("id") restaurantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.membershipService.findStaffForRestaurant(restaurantId, user);
  }

  @Get("memberships/:id")
  @UseGuards(JwtAuthGuard)
  findOne(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.membershipService.findOne(id, user);
  }

  @Patch("memberships/:id")
  @UseGuards(JwtAuthGuard)
  @AuditEntity("Membership")
  update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateMembershipSchema)) dto: UpdateMembershipDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.membershipService.update(id, dto, user);
  }

  @Patch("memberships/:id/disable")
  @UseGuards(JwtAuthGuard)
  @AuditEntity("Membership")
  disable(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.membershipService.disable(id, user);
  }

  /** restaurantId given: the Restaurant's own organizationId is authoritative, no ambiguity.
   * restaurantId omitted (org-wide invite): API_Contract.md has no nested /organizations/:id/
   * memberships route (unlike RESTAURANTS' dual create paths) to disambiguate explicitly, so this
   * derives it from the caller's own Memberships — works cleanly for the common case (one
   * Organization), and fails loudly rather than guessing for someone who owns more than one, who
   * should invite through a restaurant-scoped call instead until a dedicated route exists. */
  private async resolveOrganizationId(
    dto: InviteMembershipDto,
    user: AuthenticatedUser,
  ): Promise<string> {
    if (dto.restaurantId) {
      const restaurant = await this.prisma.restaurant.findFirst({
        where: { id: dto.restaurantId, deletedAt: null },
      });
      if (!restaurant) {
        throw new AppException("RESTAURANT_NOT_FOUND", "Restaurant not found.", 404);
      }
      return restaurant.organizationId;
    }

    const orgIds = [...new Set(user.memberships.map((m) => m.organizationId))];
    if (orgIds.length !== 1) {
      throw new AppException(
        "VALIDATION_ERROR",
        "Cannot determine which Organization to invite into — specify restaurantId, or ensure you belong to exactly one Organization.",
        400,
      );
    }
    return orgIds[0];
  }
}
