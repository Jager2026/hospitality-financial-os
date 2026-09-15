import { Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { RequirePermission } from "../auth/decorators/require-permission.decorator";
import { JwtAuthGuard, type AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { PermissionsGuard } from "../auth/guards/permissions.guard";
import { AppException } from "../common/exceptions/app.exception";
import { hasPermissionAtRestaurant } from "../common/restaurant-reachability.util";
import { PrismaService } from "../prisma/prisma.service";
import { ShiftCloseSummaryService, type ShiftCloseSummary } from "./shift-close-summary.service";
import { ShiftService } from "./shift.service";

/**
 * **How long a close waits for the money question to become answerable, and why this number.**
 *
 * Measured on 2026-09-15: Stripe publishes a charge's BalanceTransaction **2.4–3.1 seconds** after
 * the charge (8 of 8, median 2635 ms). ADR-094's fetch then runs on the Outbox's own schedule —
 * a 2-second poll, a 2/4/8-second backoff, and a **four-attempt cap** — so its whole window closes
 * by about fourteen seconds. Fifteen covers it with nothing left over.
 *
 * **What this is NOT:** a guess at how long Stripe takes. Past this point the answer is not "still
 * waiting", it is `unavailable` — a different state with a different sentence on screen, because
 * ADR-094's fetch has by then given up rather than being slow.
 */
export const CLOSE_WAIT_MS = 15_000;
const CLOSE_POLL_MS = 1_000;

// API_Contract.md, SHIFTS.
@Controller("restaurants/:restaurantId/shifts")
@UseGuards(JwtAuthGuard)
export class ShiftController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shifts: ShiftService,
    private readonly summaries: ShiftCloseSummaryService,
  ) {}

  /**
   * Closes the open shift and answers the one question a close is for.
   *
   * It waits — see `CLOSE_WAIT_MS` — because the last payments of an evening are seconds old and
   * their fee has not arrived. **Returning immediately would show a total that is about to change,
   * which is worse than making somebody wait fifteen seconds for one that is not.**
   */
  @Post("close")
  @UseGuards(PermissionsGuard)
  @RequirePermission("payments.manage")
  async close(
    @Param("restaurantId") restaurantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ShiftCloseSummary> {
    await this.assertPermitted(restaurantId, user, "payments.manage");
    const shift = await this.shifts.closeByButton(restaurantId, user.id);
    return this.settledSummary(shift.id);
  }

  // DECLARED BEFORE `:shiftId/summary`, and it has to be: Nest matches routes in declaration
  // order, so a parameterised segment declared first would swallow "latest-closed" as an id.
  /** The most recent CLOSED shift — what the screen shows after a close, and on a later visit. */
  @Get("latest-closed/summary")
  @UseGuards(PermissionsGuard)
  @RequirePermission("reports.view")
  async latestClosed(
    @Param("restaurantId") restaurantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ShiftCloseSummary | null> {
    await this.assertPermitted(restaurantId, user, "reports.view");
    const shift = await this.prisma.shift.findFirst({
      where: { restaurantId, closedAt: { not: null } },
      orderBy: { closedAt: "desc" },
    });
    return shift ? this.summaries.summarise(shift.id) : null;
  }

  @Get(":shiftId/summary")
  @UseGuards(PermissionsGuard)
  @RequirePermission("reports.view")
  async summary(
    @Param("restaurantId") restaurantId: string,
    @Param("shiftId") shiftId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ShiftCloseSummary> {
    await this.assertPermitted(restaurantId, user, "reports.view");
    const shift = await this.prisma.shift.findUnique({ where: { id: shiftId } });
    if (!shift || shift.restaurantId !== restaurantId) {
      throw new AppException("NOT_FOUND", "Shift not found.", 404);
    }
    // No wait here: a summary read after the fact asks about a shift that has stopped moving.
    return this.summaries.summarise(shiftId);
  }

  /** Polls until nothing is `pending`, or until the wait is spent — whichever comes first. */
  private async settledSummary(shiftId: string): Promise<ShiftCloseSummary> {
    const deadline = Date.now() + CLOSE_WAIT_MS;
    let summary = await this.summaries.summarise(shiftId);
    while (summary.availability.state === "pending" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, CLOSE_POLL_MS));
      summary = await this.summaries.summarise(shiftId);
    }
    return summary;
  }

  /**
   * ADR-043's rule, not a re-implementation of it: the permission must be held **at this
   * restaurant**, through a Membership that actually reaches it — never merely held somewhere.
   */
  private async assertPermitted(
    restaurantId: string,
    user: AuthenticatedUser,
    permission: string,
  ): Promise<void> {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId, deletedAt: null },
      select: { id: true, organizationId: true },
    });
    if (!restaurant) {
      throw new AppException("RESTAURANT_NOT_FOUND", "Restaurant not found.", 404);
    }
    if (!hasPermissionAtRestaurant(user, restaurant, permission)) {
      // 404 rather than 403, mirroring TransactionService: confirming that a restaurant exists to
      // a caller who cannot reach it is itself the disclosure.
      throw new AppException("RESTAURANT_NOT_FOUND", "Restaurant not found.", 404);
    }
  }
}
