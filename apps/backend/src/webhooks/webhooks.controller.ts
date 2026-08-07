import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  type RawBodyRequest,
} from "@nestjs/common";
import type { Request } from "express";
import { AppException } from "../common/exceptions/app.exception";
import { WebhooksService } from "./webhooks.service";

// API_Contract.md, Incoming Webhooks — Stripe. Public, no JwtAuthGuard: the caller is Stripe, not
// one of our Users — the signature (verified inside WebhooksService, using the exact raw bytes
// main.ts's rawBody:true captures) is the authentication.
@Controller("webhooks")
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post("stripe")
  @HttpCode(HttpStatus.OK)
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
