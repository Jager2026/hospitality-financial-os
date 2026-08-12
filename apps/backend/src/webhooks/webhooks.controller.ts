import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  type RawBodyRequest,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { AppException } from "../common/exceptions/app.exception";
import { WebhooksService } from "./webhooks.service";

// API_Contract.md, Incoming Webhooks — Stripe. Public, no JwtAuthGuard: the caller is Stripe, not
// one of our Users — the signature (verified inside WebhooksService, using the exact raw bytes
// main.ts's rawBody:true captures) is the authentication.
@Controller("webhooks")
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  // Sprint 11 (ADR-028): raised to 500/min, not tightened — investigated per the Founder's own
  // instruction rather than assumed. The signature is already verified before any processing, so
  // a rate limit here buys no additional authentication; its only job is bounding raw request
  // volume. ThrottlerGuard's default IP-based tracking is a poor fit for this route specifically:
  // Stripe's webhook senders come from Stripe's own shared, published IP pool, not a per-Restaurant
  // address, so the 100/min platform-wide baseline is actually a PLATFORM-WIDE ceiling across every
  // connected account's events combined — one busy day across several restaurants (each payment
  // firing multiple distinct event types, plus Stripe's own retry behavior) can plausibly exceed
  // that. 500/min is a generous, deliberately round ceiling against a genuinely pathological flood,
  // not a measured real-traffic number (none exists pre-launch) — revisit against real production
  // Stripe volume once it exists, same "revisit once it shows up in practice" precedent as
  // MAX_RANGE_DAYS (ADR-027) and the DST-day caveat (ADR-026).
  @Post("stripe")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 500, ttl: 60_000 } })
  handleStripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers("stripe-signature") signature: string | undefined,
  ) {
    if (!req.rawBody) {
      throw new AppException("VALIDATION_ERROR", "Missing raw request body.", 400);
    }
    return this.webhooksService.handleEvent(req.rawBody, signature);
  }
}
