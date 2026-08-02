import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { OutboxPollerService } from "./outbox-poller.service";

@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [OutboxPollerService],
})
export class OutboxModule {}
