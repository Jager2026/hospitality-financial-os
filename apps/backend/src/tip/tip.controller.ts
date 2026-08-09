import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard, type AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { TipService } from "./tip.service";

// API_Contract.md, TIPS. Read-only throughout — there is no POST /tips (ADR-007/ADR-022).
@Controller()
@UseGuards(JwtAuthGuard)
export class TipController {
  constructor(private readonly tipService: TipService) {}

  // Registered before "tips/:id" deliberately — Nest matches routes in declaration order, and
  // "tips/:id" would otherwise swallow "tips/me" by treating "me" as an id.
  @Get("tips/me")
  findMine(@CurrentUser() user: AuthenticatedUser) {
    return this.tipService.findMine(user);
  }

  @Get("tips/:id")
  findOne(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tipService.findOne(id, user);
  }

  @Get("restaurants/:id/tips")
  findForRestaurant(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tipService.findForRestaurant(id, user);
  }
}
