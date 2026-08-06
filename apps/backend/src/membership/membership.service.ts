import { Injectable } from "@nestjs/common";
import type { Membership } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { AppException } from "../common/exceptions/app.exception";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class MembershipService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every Membership the caller can reach — team-visibility, not "my own Memberships" (that's
   * /auth/me). Same rule as everywhere else (ADR-005), and the same bug shape caught live in
   * restaurant.service.ts this session: an org-wide Membership (restaurantId === null) reaches
   * every Membership in its Organization; a restaurant-scoped one reaches only Memberships at
   * that exact Restaurant — using every membership's organizationId here regardless of scope
   * would let a restaurant-scoped Manager see the whole Organization's team, not just their own
   * Restaurant's. */
  findAllForUser(user: AuthenticatedUser): Promise<Membership[]> {
    const orgWideOrgIds = [
      ...new Set(
        user.memberships.filter((m) => m.restaurantId === null).map((m) => m.organizationId),
      ),
    ];
    const restaurantIds = [
      ...new Set(
        user.memberships
          .filter((m) => m.restaurantId !== null)
          .map((m) => m.restaurantId as string),
      ),
    ];

    return this.prisma.membership.findMany({
      where: {
        deletedAt: null,
        OR: [{ organizationId: { in: orgWideOrgIds } }, { restaurantId: { in: restaurantIds } }],
      },
    });
  }

  async findOne(id: string, user: AuthenticatedUser): Promise<Membership> {
    return this.getReachableOrThrow(id, user);
  }

  async update(id: string, dto: { roleId?: string }, user: AuthenticatedUser): Promise<Membership> {
    const membership = await this.getReachableOrThrow(id, user);
    this.assertPermission(user, membership, "membership.manage");

    if (dto.roleId) {
      const role = await this.prisma.role.findUnique({ where: { id: dto.roleId } });
      if (!role) {
        throw new AppException("VALIDATION_ERROR", "Role not found.", 400);
      }
    }

    return this.prisma.membership.update({ where: { id: membership.id }, data: dto });
  }

  async disable(id: string, user: AuthenticatedUser): Promise<Membership> {
    const membership = await this.getReachableOrThrow(id, user);
    this.assertPermission(user, membership, "membership.manage");

    return this.prisma.membership.update({
      where: { id: membership.id },
      data: { status: "INACTIVE" },
    });
  }

  private async getReachableOrThrow(id: string, user: AuthenticatedUser): Promise<Membership> {
    const membership = await this.prisma.membership.findFirst({
      where: { id, deletedAt: null },
    });
    if (!membership) {
      throw new AppException("MEMBERSHIP_NOT_FOUND", "Membership not found.", 404);
    }
    const reachable = user.memberships.some(
      (m) =>
        m.restaurantId === membership.restaurantId ||
        (m.restaurantId === null && m.organizationId === membership.organizationId),
    );
    if (!reachable) {
      throw new AppException("MEMBERSHIP_NOT_FOUND", "Membership not found.", 404);
    }
    return membership;
  }

  // Same defense-in-depth split as restaurant.service.ts: PermissionsGuard is the fast global
  // reject, this is the resource-scoped check for the specific Membership being acted on.
  private assertPermission(
    user: AuthenticatedUser,
    membership: Membership,
    permission: string,
  ): void {
    const hasPermission = user.memberships.some(
      (m) =>
        (m.restaurantId === membership.restaurantId ||
          (m.restaurantId === null && m.organizationId === membership.organizationId)) &&
        m.role.permissions.includes(permission),
    );
    if (!hasPermission) {
      throw new AppException(
        "PERMISSION_DENIED",
        `Missing required permission: ${permission}`,
        403,
      );
    }
  }
}
