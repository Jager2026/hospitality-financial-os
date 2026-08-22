import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { AlertModule } from "../common/alerting/alert.module";
import { WalletModule } from "../wallet/wallet.module";
import { OutboxPollerService } from "./outbox-poller.service";

@Module({
  // ADR-024: WalletProjectionService is the poller's first real dispatch target.
  // ADR-032: AlertModule exports the AlertService this poller shares with PaymentReconciliationService.
  imports: [ScheduleModule.forRoot(), WalletModule, AlertModule],
  providers: [OutboxPollerService],
})
export class OutboxModule {}
