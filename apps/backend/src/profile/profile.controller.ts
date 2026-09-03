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

  /** Everything the token already carried, plus `displayName` from the User row — additive,
   * so `memberships` and every other field an existing caller reads stay exactly as they were
   * (UX_API_RECONCILIATION, section B: the logged-in person could not read their own name). */
  @Get()
  async get(@CurrentUser() user: AuthenticatedUser) {
    const identity = await this.profileService.getIdentity(user.id);
    return { ...user, displayName: identity.displayName };
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
