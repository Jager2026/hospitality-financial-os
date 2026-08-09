import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { IndividualTipAllocationStrategy } from "./individual-tip-allocation.strategy";
import { TIP_ALLOCATION_STRATEGY } from "./tip-allocation-strategy.interface";
import { TipController } from "./tip.controller";
import { TipService } from "./tip.service";

@Module({
  imports: [AuthModule], // JwtAuthGuard's own dependencies — same checklist item CLAUDE_RULES.md flags
  controllers: [TipController],
  providers: [
    TipService,
    // ADR-007's MVP selection: Individual. Swapping strategies later is a change to this one
    // binding, not to WebhooksService or the Ledger-posting code that consumes it.
    { provide: TIP_ALLOCATION_STRATEGY, useClass: IndividualTipAllocationStrategy },
  ],
  exports: [TIP_ALLOCATION_STRATEGY],
})
export class TipModule {}
