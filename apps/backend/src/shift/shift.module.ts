import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ShiftCloseSummaryService } from "./shift-close-summary.service";
import { ShiftController } from "./shift.controller";
import { ShiftService } from "./shift.service";

// ScheduleModule.forRoot() is registered once, in OutboxModule — Nest discovers @Interval
// providers app-wide from that single registration, so this module must not register it again.
//
// AuthModule is imported because ShiftController uses JwtAuthGuard and PermissionsGuard, and a
// Guard whose own dependencies are not in scope compiles, typechecks, and then refuses to start
// the application — CLAUDE_RULES.md's flagged checklist item, paid for twice already.
@Module({
  imports: [AuthModule],
  controllers: [ShiftController],
  providers: [ShiftService, ShiftCloseSummaryService],
  exports: [ShiftService, ShiftCloseSummaryService],
})
export class ShiftModule {}
