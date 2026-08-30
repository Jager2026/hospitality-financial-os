import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Payment, Restaurant } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { AppException } from "../common/exceptions/app.exception";
import { permittedScope } from "../common/restaurant-reachability.util";
import { PrismaService } from "../prisma/prisma.service";
import { StripeService } from "../stripe/stripe.service";
import type { CreatePaymentDto } from "./dto/create-payment.schema";
import { splitPlatformFee } from "./platform-fee.util";
import {
  findGrantingMembership,
  hasPermissionAtRestaurant,
  isRestaurantReachable,
} from "../common/restaurant-reachability.util";

export interface CreatedPayment {
  id: string;
  restaurantId: string;
  amount: string; // bigint -> string at the source; see bigint-json.polyfill for the general case
  tipAmount: string;
  // ADR-033: included so AuditLogInterceptor's own generic response-shape extraction (writeSuccess
  // looking for a `waiterMembershipId` field, the same convention it already uses for `id`) can
  // record the selected tip recipient alongside the automatically-captured, already-logged
  // request.user.id — "who was selected" and "who was logged in" are two independently recorded
  // facts, never inferred from one another.
  waiterMembershipId: string | null;
  currency: string;
  status: Payment["status"];
  clientSecret: string;
}

export interface PaymentHistoryPage {
  data: Payment[];
  meta: { page: number; limit: number; total: number; pages: number };
}

/** ADR-043: reading a restaurant's payment history is the same question the Dashboard and the
 * Transactions list answer, so it carries the same threshold. Different formats of one question
 * must not have different bars. */
export const PAYMENT_READ_PERMISSION = "reports.view";

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
    // Authorization only (ADR-033) — confirms the caller is allowed to process a payment at this
    // Restaurant. No longer the source of Payment.waiterMembershipId (below); "who is logged in"
    // and "who is selected as the tip recipient" are independent facts now, not the same one.
    this.getGrantingMembershipOrThrow(user, restaurant, "payments.manage");
    const waiterMembershipId = await this.validateWaiterMembershipOrThrow(dto, restaurant);

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
        waiterMembershipId,
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
      waiterMembershipId: payment.waiterMembershipId,
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
    await this.assertPermittedAtRestaurant(payment, user);
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
    // ADR-043. Found by auditing for the shape the transaction leak had, not by a test reaching
    // here: this list was built from every Membership the caller holds, so a Waiter at one
    // restaurant saw its full payment history — amounts and tips — with no permission anywhere in
    // the path. A Payment is the restaurant's takings, not the waiter's; their own money is the
    // Wallet and `GET /tips/me`, reached by ownership rather than by a claim on someone else's
    // finances.
    const { organizationIds: orgWideOrgIds, restaurantIds } = permittedScope(
      user,
      PAYMENT_READ_PERMISSION,
    );

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

  /**
   * Scope check for a single Payment read by id (`GET /payments/{id}`, `.../status`).
   *
   * **Reachability alone used to be the whole rule here, and it leaked.** Measured, not inferred
   * (PR #108): a caller whose only relationship to this Restaurant was a zero-permission Waiter
   * Membership received the full payment body — amount, tip, currency, processor id, idempotency
   * key. `isRestaurantReachable` is satisfied by *any* Membership, and these routes carried no
   * `@RequirePermission` above them, so nothing narrowed it.
   *
   * The fix is `hasPermissionAtRestaurant`, which is not a new rule: it is
   * `findGrantingMembership` — the same predicate `permittedScope` filters the LIST routes with —
   * asked about one known row instead of used to build a query. ADR-043 closed this shape for the
   * lists; the by-id reads were simply never part of that change. Asking the same question two
   * ways would eventually answer it two ways.
   *
   * A Waiter reading their own money is not what this refuses. That is the Wallet and
   * `GET /tips/me`, reached by ownership; a Payment is the restaurant's takings (ADR-043).
   */
  private async assertPermittedAtRestaurant(
    payment: Payment,
    user: AuthenticatedUser,
  ): Promise<void> {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: payment.restaurantId },
    });
    // Should never actually be null (Payment.restaurantId is a required FK) — a defensive
    // boundary check, not a real business case.
    if (!restaurant) {
      throw new AppException("PAYMENT_NOT_FOUND", "Payment not found.", 404);
    }
    if (!hasPermissionAtRestaurant(user, restaurant, PAYMENT_READ_PERMISSION)) {
      // 404, not 403: the caller may hold no permission here at all, and confirming that a payment
      // exists at a restaurant they cannot read is itself the disclosure. Matches what the list
      // routes already do by simply not returning the row.
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
    const reachable = isRestaurantReachable(user, restaurant);
    if (!reachable) {
      throw new AppException("RESTAURANT_NOT_FOUND", "Restaurant not found.", 404);
    }
    return restaurant;
  }

  /** ADR-033: validates a client-submitted waiterMembershipId is a real, ACTIVE, non-deleted
   * Membership reachable at this Restaurant (same reachability rule as everywhere else, ADR-005)
   * — never trusted as a bare string. Undefined is valid on its own (createPaymentSchema's own
   * .refine() already guarantees it's only undefined when tipAmount is 0 — nobody to attribute).
   * Deliberately NOT restricted to any one Role (Founder decision) — "who actually served this
   * table," not "who holds the Waiter Role." */
  private async validateWaiterMembershipOrThrow(
    dto: CreatePaymentDto,
    restaurant: Restaurant,
  ): Promise<string | null> {
    if (!dto.waiterMembershipId) return null;

    const membership = await this.prisma.membership.findFirst({
      where: {
        id: dto.waiterMembershipId,
        deletedAt: null,
        status: "ACTIVE",
        OR: [
          { restaurantId: restaurant.id },
          { restaurantId: null, organizationId: restaurant.organizationId },
        ],
      },
    });
    if (!membership) {
      throw new AppException(
        "VALIDATION_ERROR",
        "waiterMembershipId is not a valid staff member at this restaurant.",
        400,
      );
    }
    return membership.id;
  }

  // Same defense-in-depth split as restaurant.service.ts/membership.service.ts: PermissionsGuard
  // is the fast global reject, this is the resource-scoped second layer — confirms the caller
  // themselves may process a payment at this Restaurant (ADR-033: authorization only, no longer
  // the source of Payment.waiterMembershipId — see validateWaiterMembershipOrThrow above for that).
  private getGrantingMembershipOrThrow(
    user: AuthenticatedUser,
    restaurant: Restaurant,
    permission: string,
  ): AuthenticatedUser["memberships"][number] {
    const membership = findGrantingMembership(user, restaurant, permission);
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
