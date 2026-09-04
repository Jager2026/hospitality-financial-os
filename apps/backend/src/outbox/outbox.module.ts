import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { AlertModule } from "../common/alerting/alert.module";
import { EmailModule } from "../email/email.module";
import { WalletModule } from "../wallet/wallet.module";
import { OutboxPollerService } from "./outbox-poller.service";

@Module({
  // ADR-024: WalletProjectionService is the poller's first real dispatch target.
  // ADR-032: AlertModule exports the AlertService this poller shares with PaymentReconciliationService.
  // ADR-069: EmailModule provides EmailOutboxService, the poller's second dispatch target. The
  // import is required even though the Guard-style trap does not apply here — a provider injected
  // without its module imported fails at Nest bootstrap, not at compile time.
  imports: [ScheduleModule.forRoot(), WalletModule, AlertModule, EmailModule],
  providers: [OutboxPollerService],
})
export class OutboxModule {}
