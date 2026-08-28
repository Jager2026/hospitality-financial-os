import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { RoleController } from "./role.controller";
import { RoleService } from "./role.service";

// AuthModule imported because JwtAuthGuard has its own constructor dependencies — a Guard
// typechecks fine without it and fails only at runtime, when Nest cannot resolve them in this
// module's scope (CLAUDE.md's Architecture Review paragraph, learned from OrganizationModule and
// RestaurantModule doing exactly this in Sprint 3).
@Module({
  imports: [AuthModule],
  controllers: [RoleController],
  providers: [RoleService],
  exports: [RoleService],
})
export class RoleModule {}
