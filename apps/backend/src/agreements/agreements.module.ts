import { Module } from "@nestjs/common";
import { AgreementsController } from "./agreements.controller";

// No providers and no imports: the controller reads two constants and has no dependencies. Worth
// stating rather than leaving to be inferred — the Architecture Review rule in CLAUDE.md exists
// because a module using a Guard without importing what that Guard needs fails only at boot. This
// module uses no Guard, which is why there is nothing to import.
@Module({ controllers: [AgreementsController] })
export class AgreementsModule {}
