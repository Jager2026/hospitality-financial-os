import { Body, Controller, Get, Param, Patch, UseGuards } from "@nestjs/common";
import { AuditEntity } from "../common/decorators/audit-entity.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard, type AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import {
  updateTipSettingsSchema,
  type UpdateTipSettingsDto,
} from "./dto/update-tip-settings.schema";
import { SettingsService } from "./settings.service";

// API_Contract.md, SETTINGS — Tip Configuration.
@Controller()
@UseGuards(JwtAuthGuard)
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get("restaurants/:id/settings/tips")
  getTipSettings(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.settingsService.getTipSettings(id, user);
  }

  @Patch("restaurants/:id/settings/tips")
  @AuditEntity("Restaurant")
  updateTipSettings(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateTipSettingsSchema)) dto: UpdateTipSettingsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.settingsService.updateTipSettings(id, dto, user);
  }
}
