import { Controller, Get, UseGuards } from "@nestjs/common";
import { RequirePermission } from "../auth/decorators/require-permission.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { PermissionsGuard } from "../auth/guards/permissions.guard";
import { RoleService } from "./role.service";

// API_Contract.md, ROLES (ADR-044).
@Controller()
@UseGuards(JwtAuthGuard)
export class RoleController {
  constructor(private readonly roleService: RoleService) {}

  /**
   * Gated on `membership.invite` rather than a new permission of its own: this list exists to
   * populate the invite screen, so the people who may invite are exactly the people who need it.
   * Inventing `roles.view` would add a permission nobody could explain the absence of.
   *
   * Reference data, identical for every caller — no reachability scoping, because a Role is not
   * owned by an Organization. `platformOnly` Roles are excluded in the service.
   */
  @Get("roles")
  @UseGuards(PermissionsGuard)
  @RequirePermission("membership.invite")
  findAssignable() {
    return this.roleService.findAssignable();
  }
}
