import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import {
  CURRENT_PLATFORM_TERMS_VERSION,
  assertPlatformTermsPublished,
} from "../common/agreements/agreement-versions";
import { AuditEntity } from "../common/decorators/audit-entity.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AuthService } from "./auth.service";
import { CurrentUser } from "./decorators/current-user.decorator";
import { loginSchema, type LoginDto } from "./dto/login.schema";
import { refreshSchema, type RefreshDto } from "./dto/refresh.schema";
import { registerSchema, type RegisterDto } from "./dto/register.schema";
import { JwtAuthGuard, type AuthenticatedUser } from "./guards/jwt-auth.guard";

// API_Contract.md, Rate Limiting: "Authentication 10/min" — stricter than Sprint 1's global
// baseline (100/min), active from Sprint 1 per ADR-010, tuned here per-route.
@Controller("auth")
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Post("register")
  @AuditEntity("Authentication")
  register(@Body(new ZodValidationPipe(registerSchema)) dto: RegisterDto, @Req() req: Request) {
    // ADR-055. The pre-pilot gate, on the route rather than on the screen.
    //
    // It was written as "the registration screen must not be shown to a real restaurant", and the
    // route kept accepting requests regardless — so a real acceptance row naming a document that
    // does not exist reached production anyway. A gate that protects a screen protects nothing.
    //
    // Here rather than inside `AuthService.register`, deliberately: this is a statement about
    // whether the route is open at all, not a rule about registering, and putting it here keeps
    // `ConfigService` out of a constructor that eleven tests build by hand.
    assertPlatformTermsPublished(
      this.config.getOrThrow<string>("NODE_ENV"),
      CURRENT_PLATFORM_TERMS_VERSION,
    );

    // ADR-049: the acceptance record carries where it came from, so the same context the refresh
    // route already collects is passed here too.
    return this.authService.register(dto, {
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @AuditEntity("Authentication")
  login(@Body(new ZodValidationPipe(loginSchema)) dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @AuditEntity("Authentication")
  refresh(@Body(new ZodValidationPipe(refreshSchema)) dto: RefreshDto, @Req() req: Request) {
    return this.authService.refresh(dto.refreshToken, {
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @AuditEntity("Authentication")
  logout(@Body(new ZodValidationPipe(refreshSchema)) dto: RefreshDto, @Req() req: Request) {
    return this.authService.logout(dto.refreshToken, {
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }
}
