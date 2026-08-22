import { Module } from "@nestjs/common";
import { LedgerModule } from "../ledger/ledger.module";
import { RestaurantModule } from "../restaurant/restaurant.module";
import { StripeModule } from "../stripe/stripe.module";
import { TipModule } from "../tip/tip.module";
import { WebhooksController } from "./webhooks.controller";
import { WebhooksService } from "./webhooks.service";

@Module({
  imports: [StripeModule, LedgerModule, RestaurantModule, TipModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
  // ADR-032: PaymentReconciliationModule reuses captureFromPaymentIntentId for self-healing.
  exports: [WebhooksService],
})
export class WebhooksModule {}
