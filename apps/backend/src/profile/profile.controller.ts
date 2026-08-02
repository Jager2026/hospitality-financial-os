import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { AuditEntity } from "../common/decorators/audit-entity.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { updateProfileSchema, type UpdateProfileDto } from "../auth/dto/update-profile.schema";
import { JwtAuthGuard, type AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { ProfileService } from "./profile.service";

// API_Contract.md, PROFILE: GET /profile — PATCH /profile
@Controller("profile")
@UseGuards(JwtAuthGuard)
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }

  @Patch()
  @AuditEntity("User")
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(updateProfileSchema)) dto: UpdateProfileDto,
  ) {
    return this.profileService.updateLocale(user.id, dto.locale);
  }
}
