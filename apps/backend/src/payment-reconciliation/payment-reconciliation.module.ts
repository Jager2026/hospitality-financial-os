import { Module } from "@nestjs/common";
import { AlertModule } from "../common/alerting/alert.module";
import { StripeModule } from "../stripe/stripe.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { PaymentReconciliationService } from "./payment-reconciliation.service";

@Module({
  // ScheduleModule.forRoot() is registered once, in OutboxModule — @nestjs/schedule discovers
  // @Interval/@Cron providers app-wide from wherever forRoot() lands, not per-module.
  imports: [StripeModule, WebhooksModule, AlertModule],
  providers: [PaymentReconciliationService],
})
export class PaymentReconciliationModule {}
