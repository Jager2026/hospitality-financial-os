import { Module } from "@nestjs/common";
import { ShiftService } from "./shift.service";

// ScheduleModule.forRoot() is registered once, in OutboxModule — Nest discovers @Interval
// providers app-wide from that single registration, so this module must not register it again.
@Module({
  providers: [ShiftService],
  exports: [ShiftService],
})
export class ShiftModule {}
