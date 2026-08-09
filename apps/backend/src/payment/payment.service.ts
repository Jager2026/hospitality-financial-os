import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Payment, Restaurant } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { AppException } from "../common/exceptions/app.exception";
import { PrismaService } from "../prisma/prisma.service";
import { StripeService } from "../stripe/stripe.service";
import type { CreatePaymentDto } from "./dto/create-payment.schema";
import { splitPlatformFee } from "./platform-fee.util";

export interface CreatedPayment {
  id: string;
  restaurantId: string;
  amount: string; // bigint -> string at the source; see bigint-json.polyfill for the general case
  tipAmount: string;
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
    private readonly config: ConfigService,
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
    const waiterMembership = this.getGrantingMembershipOrThrow(user, restaurant, "payments.manage");

    if (!restaurant.stripeAccountId) {
      throw new AppException(
        "RESTAURANT_NOT_FOUND",
        "Restaurant has no Stripe account — complete onboarding before accepting payments.",
        404,
      );
    }

    const amount = BigInt(dto.amount);
    const tipAmount = BigInt(dto.tipAmount);
    // ADR-021/ADR-022: the platform fee excludes tips. billAmount, never the full amount, is what
    // every splitPlatformFee() call site must use — this one (Stripe's own application_fee_amount)
    // and WebhooksService's (what posts to PLATFORM_FEE_REVENUE) compute from the identical
    // billAmount, so the two numbers can never drift apart.
    const billAmount = amount - tipAmount;

    // Founder decision: DEFAULT_PLATFORM_FEE_BASIS_POINTS (100 = 1.00%), a percentage of
    // Restaurant Revenue only — the same split computed again from billAmount in
    // WebhooksService's payment_intent.succeeded handler, so the amount actually deducted by
    // Stripe (application_fee_amount) and the amount posted to PLATFORM_FEE_REVENUE in the
    // Ledger are computed by the identical function, never two independent numbers that could
    // drift apart.
    const basisPoints = this.config.getOrThrow<number>("DEFAULT_PLATFORM_FEE_BASIS_POINTS");
    const { feeAmount } = splitPlatformFee(billAmount, basisPoints);

    const intent = await this.stripe.createPaymentIntent({
      stripeAccountId: restaurant.stripeAccountId,
      amount,
      currency: restaurant.currency,
      applicationFeeAmount: feeAmount,
    });

    const payment = await this.prisma.payment.create({
      data: {
        restaurantId: restaurant.id,
        processor: "stripe",
        processorPaymentId: intent.id,
        amount,
        tipAmount,
        waiterMembershipId: waiterMembership.id,
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
      tipAmount: payment.tipAmount.toString(),
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
  // is the fast global reject, this is the resource-scoped second layer. Returns the specific
  // granting Membership, not just a boolean (ADR-022) — its id becomes Payment.waiterMembershipId,
  // the tip recipient, captured from the same reachability check that already authorizes the
  // request rather than a second, separate lookup.
  private getGrantingMembershipOrThrow(
    user: AuthenticatedUser,
    restaurant: Restaurant,
    permission: string,
  ): AuthenticatedUser["memberships"][number] {
    const membership = user.memberships.find(
      (m) =>
        (m.restaurantId === restaurant.id ||
          (m.restaurantId === null && m.organizationId === restaurant.organizationId)) &&
        m.role.permissions.includes(permission),
    );
    if (!membership) {
      throw new AppException(
        "PERMISSION_DENIED",
        `Missing required permission: ${permission}`,
        403,
      );
    }
    return membership;
  }
}
