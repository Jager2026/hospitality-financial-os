import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export interface AssignableRole {
  id: string;
  name: string;
  /** Seeded alongside the name (`prisma/seed.ts`) and returned because the invite screen shows
   * this list to a human. "Manager" in a dropdown, with nothing saying how it differs from
   * "Administrator", makes an owner guess at a permission grant. */
  description: string | null;
}

/**
 * ADR-044. The data source for the Invite Employee screen.
 *
 * `POST /memberships` has required a `roleId` since Sprint 4 and **nothing has ever returned one**
 * — no `RoleController` existed. That is the shape ADR-039 named: a required input with nothing
 * addressable behind it. The screen was unbuildable, and the e2e fixture had to read the id
 * straight from the database to work around it.
 */
@Injectable()
export class RoleService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every Role a Restaurant may actually grant.
   *
   * Excludes `platformOnly` Roles — today that is "Administrator", seeded with every Permission
   * and described as platform-level. **This is one half of a two-sided rule; the other half is in
   * `MembershipInvitationService`, which rejects the same Roles.** Filtering only here would be
   * the failure ADR-031 records as the worse kind: the dropdown looks right while a direct call to
   * the API still grants the Role, and nothing anywhere reports it.
   */
  async findAssignable(): Promise<AssignableRole[]> {
    return this.prisma.role.findMany({
      where: { platformOnly: false },
      select: { id: true, name: true, description: true },
      orderBy: { name: "asc" },
    });
  }
}
