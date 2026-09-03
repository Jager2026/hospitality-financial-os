import { Controller, Get, Header, Query, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { RequirePermission } from "../auth/decorators/require-permission.decorator";
import { JwtAuthGuard, type AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { PermissionsGuard } from "../auth/guards/permissions.guard";
import { SkipEnvelope } from "../common/decorators/skip-envelope.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AnalyticsService } from "./analytics.service";
import {
  analyticsQuerySchema,
  reportsQuerySchema,
  staffAnalyticsQuerySchema,
  type AnalyticsQueryDto,
  type ReportsQueryDto,
  type StaffAnalyticsQueryDto,
} from "./dto/analytics-query.schema";

// API_Contract.md, ANALYTICS. Every route requires at least reports.view (ADR-026's own gate,
// reused directly) — checked twice, same defense-in-depth shape as every other resource:
// PermissionsGuard globally (fast reject), then getReachableReportingRestaurantOrThrow inside the
// service (does the SPECIFIC reachable Membership carry it). The ten /export routes additionally
// require data.export instead (method-level @RequirePermission overrides the class-level default,
// PermissionsGuard's own getAllAndOverride) — the same permission Sprint 8's Transaction export
// already uses, and the seeded permission's own description ("Export transaction/report data")
// already names this exact use.
@Controller("analytics")
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission("reports.view")
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get("revenue")
  getRevenue(
    @Query(new ZodValidationPipe(analyticsQuerySchema)) query: AnalyticsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.analyticsService.getRevenue(query, user);
  }

  @Get("revenue/export")
  @RequirePermission("data.export")
  @SkipEnvelope()
  @Header("Content-Type", "text/csv")
  @Header("Content-Disposition", 'attachment; filename="revenue.csv"')
  exportRevenue(
    @Query(new ZodValidationPipe(analyticsQuerySchema)) query: AnalyticsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.analyticsService.exportRevenueCsv(query, user);
  }

  @Get("tips")
  getTips(
    @Query(new ZodValidationPipe(analyticsQuerySchema)) query: AnalyticsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.analyticsService.getTips(query, user);
  }

  @Get("tips/export")
  @RequirePermission("data.export")
  @SkipEnvelope()
  @Header("Content-Type", "text/csv")
  @Header("Content-Disposition", 'attachment; filename="tips.csv"')
  exportTips(
    @Query(new ZodValidationPipe(analyticsQuerySchema)) query: AnalyticsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.analyticsService.exportTipsCsv(query, user);
  }

  // ADR-065 §3 gave accounting TWO lists; ADR-067 builds the second. Separate routes, never a
  // `?byShift=true` flag: the call site has to say which question it is asking, and "by shift" /
  // "by calendar day" must be legible without a tooltip (ADR-065's own wording).
  @Get("revenue/export/by-shift")
  @RequirePermission("data.export")
  @SkipEnvelope()
  @Header("Content-Type", "text/csv")
  @Header("Content-Disposition", 'attachment; filename="revenue-by-shift.csv"')
  exportRevenueByShift(
    @Query(new ZodValidationPipe(analyticsQuerySchema)) query: AnalyticsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.analyticsService.exportRevenueByShiftCsv(query, user);
  }

  @Get("tips/export/by-shift")
  @RequirePermission("data.export")
  @SkipEnvelope()
  @Header("Content-Type", "text/csv")
  @Header("Content-Disposition", 'attachment; filename="tips-by-shift.csv"')
  exportTipsByShift(
    @Query(new ZodValidationPipe(analyticsQuerySchema)) query: AnalyticsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.analyticsService.exportTipsByShiftCsv(query, user);
  }

  // Staff earnings for a period (ADR-067). Named neutrally on purpose: it is NOT payroll, and in
  // Model B (ADR-053) the restaurant never receives the tip and cannot pay it. No salary, no
  // withholding, no tax column — VMI has not answered, and a column meaning the wrong thing is
  // worse than a column added later.
  @Get("staff-earnings/export")
  @RequirePermission("data.export")
  @SkipEnvelope()
  @Header("Content-Type", "text/csv")
  @Header("Content-Disposition", 'attachment; filename="staff-earnings-by-calendar-day.csv"')
  exportStaffEarnings(
    @Query(new ZodValidationPipe(analyticsQuerySchema)) query: AnalyticsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.analyticsService.exportStaffEarningsCsv(query, user);
  }

  @Get("staff-earnings/export/by-shift")
  @RequirePermission("data.export")
  @SkipEnvelope()
  @Header("Content-Type", "text/csv")
  @Header("Content-Disposition", 'attachment; filename="staff-earnings-by-shift.csv"')
  exportStaffEarningsByShift(
    @Query(new ZodValidationPipe(analyticsQuerySchema)) query: AnalyticsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.analyticsService.exportStaffEarningsByShiftCsv(query, user);
  }

  @Get("staff")
  getStaff(
    @Query(new ZodValidationPipe(staffAnalyticsQuerySchema)) query: StaffAnalyticsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.analyticsService.getStaff(query, user);
  }

  @Get("staff/export")
  @RequirePermission("data.export")
  @SkipEnvelope()
  @Header("Content-Type", "text/csv")
  @Header("Content-Disposition", 'attachment; filename="staff.csv"')
  exportStaff(
    @Query(new ZodValidationPipe(analyticsQuerySchema)) query: AnalyticsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.analyticsService.exportStaffCsv(query, user);
  }

  @Get("performance")
  getPerformance(
    @Query(new ZodValidationPipe(analyticsQuerySchema)) query: AnalyticsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.analyticsService.getPerformance(query, user);
  }

  @Get("performance/export")
  @RequirePermission("data.export")
  @SkipEnvelope()
  @Header("Content-Type", "text/csv")
  @Header("Content-Disposition", 'attachment; filename="performance.csv"')
  exportPerformance(
    @Query(new ZodValidationPipe(analyticsQuerySchema)) query: AnalyticsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.analyticsService.exportPerformanceCsv(query, user);
  }

  @Get("reports")
  getReport(
    @Query(new ZodValidationPipe(reportsQuerySchema)) query: ReportsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.analyticsService.getReport(query, user);
  }

  @Get("reports/export")
  @RequirePermission("data.export")
  @SkipEnvelope()
  @Header("Content-Type", "text/csv")
  @Header("Content-Disposition", 'attachment; filename="report.csv"')
  exportReport(
    @Query(new ZodValidationPipe(reportsQuerySchema)) query: ReportsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.analyticsService.exportReportCsv(query, user);
  }

  @Get("reports/export/by-shift")
  @RequirePermission("data.export")
  @SkipEnvelope()
  @Header("Content-Type", "text/csv")
  @Header("Content-Disposition", 'attachment; filename="report-by-shift.csv"')
  exportReportByShift(
    @Query(new ZodValidationPipe(reportsQuerySchema)) query: ReportsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.analyticsService.exportReportByShiftCsv(query, user);
  }
}
