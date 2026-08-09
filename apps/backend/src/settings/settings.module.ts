import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { SettingsController } from "./settings.controller";
import { SettingsService } from "./settings.service";

@Module({
  imports: [AuthModule], // JwtAuthGuard's own dependencies
  controllers: [SettingsController],
  providers: [SettingsService],
})
export class SettingsModule {}
