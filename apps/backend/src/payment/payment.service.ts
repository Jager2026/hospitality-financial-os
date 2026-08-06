import { Injectable } from "@nestjs/common";
import type { Payment, Restaurant } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { AppException } from "../common/exceptions/app.exception";
import { PrismaService } from "../prisma/prisma.service";
import { StripeService } from "../stripe/stripe.service";
import type { CreatePaymentDto } from "./dto/create-payment.schema";

export interface CreatedPayment {
  id: string;
  restaurantId: string;
  amount: string; // bigint -> string at the source; see bigint-json.polyfill for the general case
  currency: string;
  status: Payment["status"];
  clientSecret: string;
}

export interface PaymentHistoryPage {
  data: Payment[];
  meta: { page: number; limit: number; total: number; pages: number };
}

@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
  ) {}

  /** API_Contract.md, Create Payment. Creates a Stripe PaymentIntent as a direct charge on the
   * Restaurant's own connected account (ADR-014) and a PENDING Payment row referencing it. Does
   * NOT write any Ledger entry here — per ADR-015, the Ledger write happens later, asynchronously,
   * driven by the payment_intent.succeeded webhook, not synchronously in this response. */
  async createPaymentIntent(
    dto: CreatePaymentDto,
    idempotencyKey: string,
    user: AuthenticatedUser,
  ): Promise<CreatedPayment> {
    const restaurant = await this.getReachableRestaurantOrThrow(dto.restaurantId, user);
    this.assertPermission(user, restaurant, "payments.manage");

    if (!restaurant.stripeAccountId) {
      throw new AppException(
        "RESTAURANT_NOT_FOUND",
        "Restaurant has no Stripe account — complete onboarding before accepting payments.",
        404,
      );
    }

    const amount = BigInt(dto.amount);

    // No applicationFeeAmount: Sprint 5's platform-fee percentage is still an open founder
    // decision (tracked separately, not guessed) — this creates a $0-platform-fee PaymentIntent
    // today, an honest "not yet decided" state, not a fabricated split.
    const intent = await this.stripe.createPaymentIntent({
      stripeAccountId: restaurant.stripeAccountId,
      amount,
      currency: restaurant.currency,
    });

    const payment = await this.prisma.payment.create({
      data: {
        restaurantId: restaurant.id,
        processor: "stripe",
        processorPaymentId: intent.id,
        amount,
        currency: restaurant.currency,
        status: "PENDING",
        paymentMethod: "card",
        idempotencyKey,
      },
    });

    return {
      id: payment.id,
      restaurantId: payment.restaurantId,
      amount: payment.amount.toString(),
      currency: payment.currency,
      status: payment.status,
      clientSecret: intent.clientSecret,
    };
  }

  async findOne(id: string, user: AuthenticatedUser): Promise<Payment> {
    const payment = await this.prisma.payment.findUnique({ where: { id } });
    if (!payment) {
      throw new AppException("PAYMENT_NOT_FOUND", "Payment not found.", 404);
    }
    await this.assertReachable(payment, user);
    return payment;
  }

  async getStatus(id: string, user: AuthenticatedUser): Promise<{ status: Payment["status"] }> {
    const payment = await this.findOne(id, user);
    return { status: payment.status };
  }

  /** API_Contract.md, Payment History — scoped to every Restaurant the caller's Memberships
   * reach (same reachability rule as everywhere else, ADR-005), optionally narrowed further by
   * restaurantId/status. */
  async findAllForUser(
    user: AuthenticatedUser,
    filters: { restaurantId?: string; status?: Payment["status"]; page: number; limit: number },
  ): Promise<PaymentHistoryPage> {
    const orgWideOrgIds = [
      ...new Set(
        user.memberships.filter((m) => m.restaurantId === null).map((m) => m.organizationId),
      ),
    ];
    const restaurantIds = [
      ...new Set(
        user.memberships
          .filter((m) => m.restaurantId !== null)
          .map((m) => m.restaurantId as string),
      ),
    ];

    const reachableWhere = {
      OR: [
        { restaurant: { organizationId: { in: orgWideOrgIds } } },
        { restaurantId: { in: restaurantIds } },
      ],
    };

    const where = {
      AND: [
        reachableWhere,
        filters.restaurantId ? { restaurantId: filters.restaurantId } : {},
        filters.status ? { status: filters.status } : {},
      ],
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
      this.prisma.payment.count({ where }),
    ]);

    return {
      data,
      meta: {
        page: filters.page,
        limit: filters.limit,
        total,
        pages: Math.ceil(total / filters.limit),
      },
    };
  }

  private async assertReachable(payment: Payment, user: AuthenticatedUser): Promise<void> {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: payment.restaurantId },
    });
    // Should never actually be null (Payment.restaurantId is a required FK) — a defensive
    // boundary check, not a real business case.
    if (!restaurant) {
      throw new AppException("PAYMENT_NOT_FOUND", "Payment not found.", 404);
    }
    const reachable = user.memberships.some(
      (m) =>
        m.restaurantId === restaurant.id ||
        (m.restaurantId === null && m.organizationId === restaurant.organizationId),
    );
    if (!reachable) {
      throw new AppException("PAYMENT_NOT_FOUND", "Payment not found.", 404);
    }
  }

  private async getReachableRestaurantOrThrow(
    id: string,
    user: AuthenticatedUser,
  ): Promise<Restaurant> {
    const restaurant = await this.prisma.restaurant.findFirst({ where: { id, deletedAt: null } });
    if (!restaurant) {
      throw new AppException("RESTAURANT_NOT_FOUND", "Restaurant not found.", 404);
    }
    const reachable = user.memberships.some(
      (m) =>
        m.restaurantId === restaurant.id ||
        (m.restaurantId === null && m.organizationId === restaurant.organizationId),
    );
    if (!reachable) {
      throw new AppException("RESTAURANT_NOT_FOUND", "Restaurant not found.", 404);
    }
    return restaurant;
  }

  // Same defense-in-depth split as restaurant.service.ts/membership.service.ts: PermissionsGuard
  // is the fast global reject, this is the resource-scoped second layer.
  private assertPermission(
    user: AuthenticatedUser,
    restaurant: Restaurant,
    permission: string,
  ): void {
    const hasPermission = user.memberships.some(
      (m) =>
        (m.restaurantId === restaurant.id ||
          (m.restaurantId === null && m.organizationId === restaurant.organizationId)) &&
        m.role.permissions.includes(permission),
    );
    if (!hasPermission) {
      throw new AppException(
        "PERMISSION_DENIED",
        `Missing required permission: ${permission}`,
        403,
      );
    }
  }
}
