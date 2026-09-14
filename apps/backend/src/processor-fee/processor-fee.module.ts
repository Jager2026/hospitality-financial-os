import { Module } from "@nestjs/common";
import { LedgerModule } from "../ledger/ledger.module";
import { StripeModule } from "../stripe/stripe.module";
import { ProcessorFeeService } from "./processor-fee.service";

// ADR-094. Both imports are required rather than incidental — per CLAUDE.md's Architecture Review
// rule, a provider injected without its module imported typechecks fine and fails at Nest
// bootstrap, which is the failure this project has already paid for twice.
@Module({
  imports: [LedgerModule, StripeModule],
  providers: [ProcessorFeeService],
  exports: [ProcessorFeeService],
})
export class ProcessorFeeModule {}
