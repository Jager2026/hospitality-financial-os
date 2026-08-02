import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
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
  constructor(private readonly authService: AuthService) {}

  @Post("register")
  @AuditEntity("Authentication")
  register(@Body(new ZodValidationPipe(registerSchema)) dto: RegisterDto) {
    return this.authService.register(dto);
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
