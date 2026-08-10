import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { RequirePermission } from "../auth/decorators/require-permission.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard, type AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { PermissionsGuard } from "../auth/guards/permissions.guard";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { dashboardQuerySchema, type DashboardQueryDto } from "./dto/dashboard-query.schema";
import { DashboardService } from "./dashboard.service";

// API_Contract.md, ANALYTICS > Dashboard.
@Controller("dashboard")
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermission("reports.view")
  getSummary(
    @Query(new ZodValidationPipe(dashboardQuerySchema)) query: DashboardQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.dashboardService.getSummary(query.restaurantId, user);
  }
}
