import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AuditEntity } from "../common/decorators/audit-entity.decorator";
import { RequirePermission } from "../auth/decorators/require-permission.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard, type AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { PermissionsGuard } from "../auth/guards/permissions.guard";
import { AppException } from "../common/exceptions/app.exception";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { createRestaurantSchema, type CreateRestaurantDto } from "./dto/create-restaurant.schema";
import { updateRestaurantSchema, type UpdateRestaurantDto } from "./dto/update-restaurant.schema";
import { RestaurantService } from "./restaurant.service";

// API_Contract.md, RESTAURANTS.
@Controller()
@UseGuards(JwtAuthGuard)
export class RestaurantController {
  constructor(private readonly restaurantService: RestaurantService) {}

  // No PermissionsGuard/@RequirePermission here, deliberately: a user with zero Organizations has
  // zero Memberships to check a permission against (DATABASE.md, User Rules — "A User with zero
  // Memberships is valid"). This route auto-creates the Organization + an org-wide Owner
  // Membership for the caller (API_Contract.md, Create Restaurant), so the only real requirement
  // is being logged in.
  // Sprint 11 (ADR-028): 5/min — every call creates a real Stripe Connect account (an external
  // side effect with its own cost/quota, not just a local row) and is otherwise reachable by any
  // authenticated user with zero permission checks at all (see above), making it the cheapest
  // spam/resource-exhaustion target in the whole API. 5/min still comfortably covers the real
  // use case — a founder or chain owner setting up one, or a handful of, Restaurants in a sitting.
  @Post("restaurants")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @AuditEntity("Restaurant")
  create(
    @Body(new ZodValidationPipe(createRestaurantSchema)) dto: CreateRestaurantDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.restaurantService.create(dto, user.id, null);
  }

  // Explicit path for an existing chain adding a location (API_Contract.md, Add Restaurant to
  // Existing Organization) — unlike POST /restaurants, this one DOES require restaurant.create,
  // scoped to the target Organization: an org-wide Membership there, not just any Membership
  // anywhere (PermissionsGuard's own global check is the fast reject; the org-scoped check lives
  // in the service, same defense-in-depth split as restaurant.service.ts's own permission checks).
  // Sprint 11 (ADR-028): same 5/min as POST /restaurants above — the identical real Stripe Connect
  // account side effect, just a second entry path into the same action.
  @Post("organizations/:organizationId/restaurants")
  @UseGuards(PermissionsGuard)
  @RequirePermission("restaurant.create")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @AuditEntity("Restaurant")
  createForOrganization(
    @Param("organizationId") organizationId: string,
    @Body(new ZodValidationPipe(createRestaurantSchema)) dto: CreateRestaurantDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const isOrgWideMember = user.memberships.some(
      (m) => m.organizationId === organizationId && m.restaurantId === null,
    );
    if (!isOrgWideMember) {
      throw new AppException("ORGANIZATION_NOT_FOUND", "Organization not found.", 404);
    }
    return this.restaurantService.create(dto, user.id, organizationId);
  }

  @Get("restaurants")
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.restaurantService.findAllForUser(user);
  }

  @Get("restaurants/:id")
  findOne(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.restaurantService.findOne(id, user);
  }

  @Patch("restaurants/:id")
  @AuditEntity("Restaurant")
  update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateRestaurantSchema)) dto: UpdateRestaurantDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.restaurantService.update(id, dto, user);
  }

  @Delete("restaurants/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @AuditEntity("Restaurant")
  async remove(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.restaurantService.remove(id, user);
  }

  @Post("restaurants/:id/onboarding-link")
  @HttpCode(HttpStatus.OK)
  createOnboardingLink(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.restaurantService.createOnboardingLink(id, user).then((url) => ({ url }));
  }
}
