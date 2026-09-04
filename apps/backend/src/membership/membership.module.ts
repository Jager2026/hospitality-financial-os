import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { EmailModule } from "../email/email.module";
import { MembershipController } from "./membership.controller";
import { MembershipInvitationService } from "./membership-invitation.service";
import { MembershipService } from "./membership.service";

@Module({
  // AuthModule: JwtAuthGuard's own dependencies (TokenService, PrismaService).
  // EmailModule (ADR-070): MembershipInvitationService now enqueues the invitation email, and a
  // provider injected without its module imported fails at Nest bootstrap, not at compile time —
  // the exact trap CLAUDE.md's Architecture Review rule exists for.
  imports: [AuthModule, EmailModule],
  controllers: [MembershipController],
  providers: [MembershipService, MembershipInvitationService],
})
export class MembershipModule {}
