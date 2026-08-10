import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";

@Module({
  imports: [AuthModule], // JwtAuthGuard/PermissionsGuard's own dependencies — CLAUDE_RULES.md's flagged checklist item
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
