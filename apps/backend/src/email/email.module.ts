import { Module } from "@nestjs/common";
import { EmailOutboxService } from "./email-outbox.service";
import { EmailService } from "./email.service";

/**
 * ADR-069. `EmailService` is the Resend transport; `EmailOutboxService` is how anything asks for a
 * send and how the poller performs one. Both are exported: producers need `enqueue`, the poller
 * needs `handle`.
 *
 * No `imports`, and that is checked rather than assumed: `ConfigModule` is registered with
 * `isGlobal: true` in `app.module.ts` and `PrismaModule` carries `@Global()`, so both providers
 * resolve without an import here. CLAUDE.md's Architecture Review rule exists because a missing
 * module import is invisible to the compiler and to any test that does not bootstrap a real Nest
 * context — so the two dependencies were looked up, not inferred from the code compiling.
 */
@Module({
  providers: [EmailService, EmailOutboxService],
  exports: [EmailService, EmailOutboxService],
})
export class EmailModule {}
