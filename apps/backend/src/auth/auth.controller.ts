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
  register(@Body(new ZodValidationPipe(registerSchema)) dto: RegisterDto, @Req() req: Request) {
    // ADR-080. The pre-pilot gate is no longer called here — it lives at `createUserAccount`, the
    // one sanctioned way to create a `User`, and this route reaches it through `AuthService`.
    //
    // ADR-055 put it here for a stated reason: "this is a statement about whether the route is open
    // at all, not a rule about registering", and keeping `ConfigService` out of a service
    // constructor that eleven tests build by hand. That reasoning was right about the route and
    // wrong about the class of defect — `POST /memberships/invitations/accept` also creates a
    // `User`, consulted nothing, and was found only by reading. A gate on one route protects
    // nothing if a second route reaches the same outcome, which is ADR-055's own sentence one level
    // out from where it was written.
    //
    // MOVED rather than duplicated, on the Founder's decision. Two copies of one rule is how the
    // two drift, and the copy that stays is the one a third path cannot avoid.
    //
    // What this costs, stated because it is a real behaviour change: the refusal now happens after
    // the password is hashed and the breach check has run, rather than before any work. Same 503,
    // same `REGISTRATION_UNAVAILABLE`, a little wasted effort on a request that is refused anyway.

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
