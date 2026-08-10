import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { TransactionController } from "./transaction.controller";
import { TransactionService } from "./transaction.service";

@Module({
  imports: [AuthModule], // JwtAuthGuard's own dependencies — same checklist item CLAUDE_RULES.md flags
  controllers: [TransactionController],
  providers: [TransactionService],
})
export class TransactionModule {}
