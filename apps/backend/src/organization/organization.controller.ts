import { Body, Controller, Get, Param, Patch, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { AuditEntity } from "../common/decorators/audit-entity.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard, type AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { OrganizationService } from "./organization.service";

const updateOrganizationSchema = z.object({ name: z.string().min(1).max(200).optional() });
type UpdateOrganizationDto = z.infer<typeof updateOrganizationSchema>;

// API_Contract.md, ORGANIZATIONS.
@Controller("organizations")
@UseGuards(JwtAuthGuard)
export class OrganizationController {
  constructor(private readonly organizationService: OrganizationService) {}

  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.organizationService.findAllForUser(user);
  }

  @Get(":id")
  findOne(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.organizationService.findOne(id, user);
  }

  @Patch(":id")
  @AuditEntity("Organization")
  update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateOrganizationSchema)) dto: UpdateOrganizationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.organizationService.update(id, dto, user);
  }
}
