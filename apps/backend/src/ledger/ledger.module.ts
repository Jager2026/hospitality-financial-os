import { Module } from "@nestjs/common";
import { LedgerService } from "./ledger.service";
import { ShiftModule } from "../shift/shift.module";

// ADR-064: the Ledger stamps every line with the Shift it was posted in, resolved inside the
// posting transaction. The dependency runs one way — Ledger knows about Shift, Shift knows
// nothing about Ledger — so there is no cycle to break later.
@Module({
  imports: [ShiftModule],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
