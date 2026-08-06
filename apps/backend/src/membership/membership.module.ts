import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { MembershipController } from "./membership.controller";
import { MembershipInvitationService } from "./membership-invitation.service";
import { MembershipService } from "./membership.service";

@Module({
  imports: [AuthModule], // JwtAuthGuard's own dependencies (TokenService, PrismaService)
  controllers: [MembershipController],
  providers: [MembershipService, MembershipInvitationService],
})
export class MembershipModule {}
