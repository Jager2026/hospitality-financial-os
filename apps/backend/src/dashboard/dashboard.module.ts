import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";
import { ShiftModule } from "../shift/shift.module";

@Module({
  imports: [AuthModule, ShiftModule], // ADR-065: this screen reads shifts, not calendar days // JwtAuthGuard/PermissionsGuard's own dependencies — CLAUDE_RULES.md's flagged checklist item
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
