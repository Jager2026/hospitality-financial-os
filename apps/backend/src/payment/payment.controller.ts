import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { RequirePermission } from "../auth/decorators/require-permission.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard, type AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { PermissionsGuard } from "../auth/guards/permissions.guard";
import { AuditEntity } from "../common/decorators/audit-entity.decorator";
import { IdempotencyInterceptor } from "../common/idempotency/idempotency.interceptor";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { createPaymentSchema, type CreatePaymentDto } from "./dto/create-payment.schema";
import {
  paymentHistoryQuerySchema,
  type PaymentHistoryQueryDto,
} from "./dto/payment-history-query.schema";
import { PaymentService } from "./payment.service";

// API_Contract.md, PAYMENTS.
@Controller("payments")
@UseGuards(JwtAuthGuard)
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  // ADR-004: requires Idempotency-Key (enforced by IdempotencyInterceptor, 400 if missing).
  // payments.manage is the same permission seed.ts already grants Owner/Administrator/Manager,
  // not Waiter — creating a payment is a mutation, same asymmetry as restaurant.edit/
  // membership.manage elsewhere (read is reachability-only, write needs the permission).
  // Sprint 11 (ADR-028): 20/min, tighter than the 100/min baseline — every call creates a real
  // Stripe PaymentIntent (a genuine external side effect, unlike a read endpoint) and this is
  // exactly the shape of endpoint card-testing fraud targets (many small authorization attempts
  // to find a working stolen card). 20/min still comfortably covers a single busy terminal's real
  // traffic. Note ThrottlerGuard (a global APP_GUARD) runs before IdempotencyInterceptor in Nest's
  // request pipeline, so even a legitimate idempotent retry with the same Idempotency-Key still
  // consumes throttle budget — an accepted tradeoff, not a claimed exemption.
  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermission("payments.manage")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @AuditEntity("Payment")
  create(
    @Body(new ZodValidationPipe(createPaymentSchema)) dto: CreatePaymentDto,
    @Headers("idempotency-key") idempotencyKey: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.paymentService.createPaymentIntent(dto, idempotencyKey, user);
  }

  @Get()
  findAll(
    @Query(new ZodValidationPipe(paymentHistoryQuerySchema)) query: PaymentHistoryQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.paymentService.findAllForUser(user, query);
  }

  @Get(":id")
  findOne(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.paymentService.findOne(id, user);
  }

  @Get(":id/status")
  @HttpCode(HttpStatus.OK)
  getStatus(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.paymentService.getStatus(id, user);
  }
}
