import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { StripeModule } from "../stripe/stripe.module";
import { RestaurantController } from "./restaurant.controller";
import { RestaurantService } from "./restaurant.service";

@Module({
  imports: [StripeModule, AuthModule], // AuthModule: JwtAuthGuard's own dependencies
  controllers: [RestaurantController],
  providers: [RestaurantService],
  exports: [RestaurantService], // WebhooksModule: account.updated re-fetches via this service
})
export class RestaurantModule {}
