import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { WalletController } from "./wallet.controller";
import { WalletProjectionService } from "./wallet-projection.service";
import { WalletService } from "./wallet.service";

@Module({
  imports: [AuthModule], // JwtAuthGuard's own dependencies — same checklist item CLAUDE_RULES.md flags
  controllers: [WalletController],
  providers: [WalletService, WalletProjectionService],
  // ADR-024: OutboxModule imports this module directly to reach WalletProjectionService — Wallet
  // is the only real Outbox consumer this sprint, so a plugin/handler-registry abstraction has
  // nothing yet to be generic over (same "flexibility on demand of the first real second
  // consumer, not in advance" precedent as ADR-007/ADR-021).
  exports: [WalletProjectionService],
})
export class WalletModule {}
