import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, type Restaurant } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { AppException } from "../common/exceptions/app.exception";
import { PrismaService } from "../prisma/prisma.service";
import { StripeService } from "../stripe/stripe.service";
import type { CreateRestaurantDto } from "./dto/create-restaurant.schema";
import type { UpdateRestaurantDto } from "./dto/update-restaurant.schema";
import { deriveOnboardingStatus } from "./onboarding-status.util";
import {
  hasPermissionAtRestaurant,
  isRestaurantReachable,
} from "../common/restaurant-reachability.util";

@Injectable()
export class RestaurantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly config: ConfigService,
  ) {}

  /**
   * POST /restaurants (bootstrap) when organizationId is null: creates a new Organization and
   * an org-wide Owner Membership for the caller in the same transaction (DATABASE.md,
   * Organization's Rules — "the creating User receives an org-wide Membership... immediately").
   * POST /organizations/:id/restaurants when organizationId is given: the caller's permission for
   * that Organization is checked by the controller/service caller before this runs.
   */
  async create(
    dto: CreateRestaurantDto,
    userId: string,
    organizationId: string | null,
  ): Promise<Restaurant> {
    const currency = await this.prisma.currency.findUnique({ where: { code: dto.currency } });
    if (!currency) {
      throw new AppException("VALIDATION_ERROR", `Unsupported currency: ${dto.currency}`, 400);
    }

    const stripeAccountId = await this.stripe.createConnectAccount({
      contactEmail: dto.email,
      displayName: dto.name,
      country: dto.country,
    });

    return this.prisma.$transaction(async (tx) => {
      let orgId = organizationId;
      if (!orgId) {
        const organization = await tx.organization.create({ data: { name: dto.name } });
        orgId = organization.id;

        const ownerRole = await tx.role.findUniqueOrThrow({ where: { name: "Owner" } });
        await tx.membership.create({
          data: {
            userId,
            organizationId: orgId,
            restaurantId: null, // org-wide (DATABASE.md, Membership Rules)
            roleId: ownerRole.id,
            status: "ACTIVE",
          },
        });
      }

      return tx.restaurant.create({
        data: {
          organizationId: orgId,
          name: dto.name,
          legalName: dto.legalName,
          companyNumber: dto.companyNumber,
          vatNumber: dto.vatNumber,
          email: dto.email,
          phone: dto.phone,
          country: dto.country,
          currency: dto.currency,
          defaultCustomerLocale: dto.defaultCustomerLocale,
          timezone: dto.timezone,
          address: dto.address,
          logoUrl: dto.logoUrl,
          stripeAccountId,
          onboardingStatus: "NOT_STARTED",
        },
      });
    });
  }

  async findAllForUser(user: AuthenticatedUser): Promise<Restaurant[]> {
    // Bug caught live this session (Sprint 4): the previous version used every membership's
    // organizationId here, regardless of whether that membership was org-wide or
    // restaurant-scoped — so a restaurant-scoped Membership (e.g. a Manager, seed.ts) could see
    // every Restaurant in the Organization, not just its own, the moment a second Restaurant
    // existed in the same Organization. Only an org-wide Membership (restaurantId === null)
    // grants "every Restaurant in this Organization" (ADR-005); a restaurant-scoped one must
    // reach only the exact Restaurant it names.
    const orgWideOrgIds = [
      ...new Set(
        user.memberships.filter((m) => m.restaurantId === null).map((m) => m.organizationId),
      ),
    ];
    const restaurantIds = user.memberships
      .filter((m) => m.restaurantId !== null)
      .map((m) => m.restaurantId as string);

    return this.prisma.restaurant.findMany({
      where: {
        deletedAt: null,
        OR: [{ organizationId: { in: orgWideOrgIds } }, { id: { in: restaurantIds } }],
      },
    });
  }

  async findOne(id: string, user: AuthenticatedUser): Promise<Restaurant> {
    const restaurant = await this.getReachableRestaurantOrThrow(id, user);
    return this.refreshStripeStatus(restaurant);
  }

  async update(id: string, dto: UpdateRestaurantDto, user: AuthenticatedUser): Promise<Restaurant> {
    const restaurant = await this.getReachableRestaurantOrThrow(id, user);
    this.assertPermission(user, restaurant, "restaurant.edit");

    return this.prisma.restaurant.update({
      where: { id: restaurant.id },
      data: dto,
    });
  }

  /**
   * Closes a venue (ADR-054). It stops trading through this platform; it is not erased.
   *
   * Operations stop — eleven read sites filter `deletedAt: null`, including the one consolidated
   * reachability gate every restaurant-scoped route passes through, so a closed venue cannot be
   * fetched, configured, staffed, invited into, or take another payment. **Reporting does not
   * stop**: payment and transaction history, wallets and the Ledger continue to carry it, because
   * a payment taken before closing still happened and the ten-year accounting floor requires it
   * to remain in the books of its own period (`PERSONAL_DATA_MAP.md` §6).
   *
   * **Nothing here touches Stripe, deliberately.** Under Direct charges with `dashboard: "full"`
   * (ADR-014) the connected account belongs to the venue's owner, who is merchant of record and
   * holds their own Stripe Dashboard login. Closing on our side ends our routing of payments
   * through it; it does not and must not close their account. The closure screen has to say so —
   * `UX_MAP.md`, "Close A Venue" — because it is the one place a person could otherwise believe
   * their ability to take money had been switched off.
   */
  async close(id: string, user: AuthenticatedUser): Promise<void> {
    const restaurant = await this.getReachableRestaurantOrThrow(id, user);
    this.assertPermission(user, restaurant, "restaurant.delete");

    await this.prisma.restaurant.update({
      where: { id: restaurant.id },
      data: { deletedAt: new Date(), status: "INACTIVE" },
    });
  }

  async createOnboardingLink(id: string, user: AuthenticatedUser): Promise<string> {
    const restaurant = await this.getReachableRestaurantOrThrow(id, user);
    if (!restaurant.stripeAccountId) {
      throw new AppException("RESTAURANT_NOT_FOUND", "Restaurant has no Stripe account.", 404);
    }
    const frontendUrl = this.config.getOrThrow<string>("FRONTEND_URL");
    return this.stripe.createOnboardingLink(
      restaurant.stripeAccountId,
      `${frontendUrl}/restaurants/${restaurant.id}/onboarding/refresh`,
      `${frontendUrl}/restaurants/${restaurant.id}/onboarding/complete`,
    );
  }

  /** Webhooks entry point (Sprint 5, account.updated): the webhook only tells us WHICH account
   * changed, never what changed to — we deliberately never parse the webhook payload's embedded
   * Account object for capability data (Stripe sends account.updated as a v1 snapshot event,
   * whose data.object is v1-shaped — flat charges_enabled/payouts_enabled booleans — even for a
   * v2-created account; ADR-009's revision exists precisely because those v1 fields don't reflect
   * real v2 capability state). Re-fetching via getAccountStatus (the same call findOne/create
   * already use) sidesteps that shape question entirely rather than guessing at it. */
  async refreshStripeStatusByAccountId(stripeAccountId: string): Promise<Restaurant | null> {
    const restaurant = await this.prisma.restaurant.findFirst({ where: { stripeAccountId } });
    if (!restaurant) return null;
    return this.refreshStripeStatus(restaurant);
  }

  private async refreshStripeStatus(restaurant: Restaurant): Promise<Restaurant> {
    if (!restaurant.stripeAccountId) return restaurant;

    const live = await this.stripe.getAccountStatus(restaurant.stripeAccountId);
    const requirementsCount = Array.isArray(live.requirementsDue) ? live.requirementsDue.length : 0;
    const onboardingStatus = deriveOnboardingStatus(
      live.cardPaymentsStatus,
      live.payoutsStatus,
      requirementsCount,
    );

    return this.prisma.restaurant.update({
      where: { id: restaurant.id },
      data: {
        cardPaymentsStatus: live.cardPaymentsStatus,
        payoutsStatus: live.payoutsStatus,
        requirementsDue: live.requirementsDue === null ? Prisma.JsonNull : live.requirementsDue,
        onboardingStatus,
      },
    });
  }

  private async getReachableRestaurantOrThrow(
    id: string,
    user: AuthenticatedUser,
  ): Promise<Restaurant> {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { id, deletedAt: null },
    });
    if (!restaurant) {
      throw new AppException("RESTAURANT_NOT_FOUND", "Restaurant not found.", 404);
    }
    const reachable = isRestaurantReachable(user, restaurant);
    if (!reachable) {
      throw new AppException("RESTAURANT_NOT_FOUND", "Restaurant not found.", 404);
    }
    return restaurant;
  }

  /** Fine-grained, per-resource permission check — PermissionsGuard only checks "does the user
   * hold this permission on ANY Membership," a fast global reject. This is the second layer:
   * does one of the SPECIFIC Memberships that actually reaches this Restaurant (restaurant-scoped
   * to it, or org-wide within its Organization) carry the permission. Same defense-in-depth shape
   * as the Ledger's write-helper + DB trigger (ADR-002/Sprint 1) — deliberately not folded into
   * PermissionsGuard itself, which has no restaurant/organization param-scoping convention yet and
   * would need one per resource type to do this generically. */
  private assertPermission(
    user: AuthenticatedUser,
    restaurant: Restaurant,
    permission: string,
  ): void {
    const hasPermission = hasPermissionAtRestaurant(user, restaurant, permission);
    if (!hasPermission) {
      throw new AppException(
        "PERMISSION_DENIED",
        `Missing required permission: ${permission}`,
        403,
      );
    }
  }
}
