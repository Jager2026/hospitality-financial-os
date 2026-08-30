import { Injectable } from "@nestjs/common";
import type { Restaurant } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { AppException } from "../common/exceptions/app.exception";
import { PrismaService } from "../prisma/prisma.service";
import type { UpdateTipSettingsDto } from "./dto/update-tip-settings.schema";
import {
  hasPermissionAtRestaurant,
  isRestaurantReachable,
} from "../common/restaurant-reachability.util";

export interface TipSettings {
  presetTips: number[];
}

// API_Contract.md, SETTINGS — Tip Configuration only (Sprint 6). Restaurant Settings generally
// (Business Details, Tax Information, etc., UX_MAP.md) belong to their own owning modules, not
// built here.
@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getTipSettings(restaurantId: string, user: AuthenticatedUser): Promise<TipSettings> {
    const restaurant = await this.getReachableRestaurantOrThrow(restaurantId, user);
    return { presetTips: restaurant.tipPresets };
  }

  async updateTipSettings(
    restaurantId: string,
    dto: UpdateTipSettingsDto,
    user: AuthenticatedUser,
  ): Promise<TipSettings> {
    const restaurant = await this.getReachableRestaurantOrThrow(restaurantId, user);
    this.assertPermission(user, restaurant, "tips.configure");

    const updated = await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: { tipPresets: dto.presetTips },
    });
    return { presetTips: updated.tipPresets };
  }

  // Same reachability rule as PaymentService/TipService/RestaurantService (ADR-005).
  private async getReachableRestaurantOrThrow(
    id: string,
    user: AuthenticatedUser,
  ): Promise<Restaurant> {
    const restaurant = await this.prisma.restaurant.findFirst({ where: { id, deletedAt: null } });
    if (!restaurant) {
      throw new AppException("RESTAURANT_NOT_FOUND", "Restaurant not found.", 404);
    }
    const reachable = isRestaurantReachable(user, restaurant);
    if (!reachable) {
      throw new AppException("RESTAURANT_NOT_FOUND", "Restaurant not found.", 404);
    }
    return restaurant;
  }

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
