import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { StripeModule } from "../stripe/stripe.module";
import { PaymentController } from "./payment.controller";
import { PaymentService } from "./payment.service";

@Module({
  imports: [StripeModule, AuthModule], // AuthModule: JwtAuthGuard's own dependencies
  controllers: [PaymentController],
  providers: [PaymentService],
})
export class PaymentModule {}
