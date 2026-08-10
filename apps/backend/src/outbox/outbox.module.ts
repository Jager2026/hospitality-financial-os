import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { WalletModule } from "../wallet/wallet.module";
import { OutboxPollerService } from "./outbox-poller.service";

@Module({
  // ADR-024: WalletProjectionService is the poller's first real dispatch target.
  imports: [ScheduleModule.forRoot(), WalletModule],
  providers: [OutboxPollerService],
})
export class OutboxModule {}
