import { Injectable } from "@nestjs/common";
import type { Organization } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { AppException } from "../common/exceptions/app.exception";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class OrganizationService {
  constructor(private readonly prisma: PrismaService) {}

  findAllForUser(user: AuthenticatedUser): Promise<Organization[]> {
    const orgIds = [...new Set(user.memberships.map((m) => m.organizationId))];
    return this.prisma.organization.findMany({
      where: { id: { in: orgIds }, deletedAt: null },
    });
  }

  async findOne(id: string, user: AuthenticatedUser): Promise<Organization> {
    const organization = await this.getReachableOrThrow(id, user);
    return organization;
  }

  async update(id: string, dto: { name?: string }, user: AuthenticatedUser): Promise<Organization> {
    const organization = await this.getReachableOrThrow(id, user);
    // seed.ts's Permission list has no organization-level entry (only restaurant.*,
    // membership.*, reports.view, etc.) — Organization editing wasn't scoped to a granular
    // permission there, so this requires org-wide membership only, not a specific permission.
    // Flagged rather than silently borrowing an unrelated permission name (CLAUDE_RULES,
    // Documentation First) — revisit if Organization-level actions need finer-grained roles.
    const isOrgWideMember = user.memberships.some(
      (m) => m.organizationId === organization.id && m.restaurantId === null,
    );
    if (!isOrgWideMember) {
      throw new AppException(
        "PERMISSION_DENIED",
        "Must be an org-wide member to edit the Organization.",
        403,
      );
    }
    return this.prisma.organization.update({ where: { id: organization.id }, data: dto });
  }

  private async getReachableOrThrow(id: string, user: AuthenticatedUser): Promise<Organization> {
    const organization = await this.prisma.organization.findFirst({
      where: { id, deletedAt: null },
    });
    if (!organization) {
      throw new AppException("ORGANIZATION_NOT_FOUND", "Organization not found.", 404);
    }
    const reachable = user.memberships.some((m) => m.organizationId === organization.id);
    if (!reachable) {
      throw new AppException("ORGANIZATION_NOT_FOUND", "Organization not found.", 404);
    }
    return organization;
  }
}
