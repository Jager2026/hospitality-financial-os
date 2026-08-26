import { Module } from "@nestjs/common";
import { AlertModule } from "../common/alerting/alert.module";
import { StripeService } from "./stripe.service";

// ADR-038: AlertModule is imported because StripeService's own boot-time credential probe reports
// through it. Per CLAUDE.md's Architecture Review rule, a module that uses a provider must import
// whatever module supplies it — a missing import here typechecks fine and fails only at runtime,
// when Nest cannot resolve the dependency and the app refuses to start.
@Module({
  imports: [AlertModule],
  providers: [StripeService],
  exports: [StripeService],
})
export class StripeModule {}
