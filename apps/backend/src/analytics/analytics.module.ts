import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AnalyticsController } from "./analytics.controller";
import { AnalyticsService } from "./analytics.service";
import { ShiftModule } from "../shift/shift.module";

@Module({
  imports: [AuthModule, ShiftModule], // JwtAuthGuard/PermissionsGuard's own dependencies — CLAUDE_RULES.md's flagged checklist item
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
