import { authedGet, authedGetText } from "../auth/authed-fetch";
import type { ApiResult } from "./client";

/**
 * The analytics module (API_Contract.md, ANALYTICS), read from the running controller rather than
 * from its name.
 *
 * ── Three facts that decided the screen, established before any of it was drawn ────────────────
 *
 * **1. The five JSON routes are shift-scoped; the exports come in two cuts.** `getRevenue` and
 * `getTips` call `computeRevenueByShift` / `computeTipsByShift` — the screen reads shifts, which is
 * ADR-065's rule and the reason a period covering one shift across midnight shows that shift's
 * whole figure rather than the part that fell before midnight. The CSV side has BOTH: `/export` is
 * calendar and `/export/by-shift` is not (ADR-067), and only `revenue`, `tips` and `reports` have
 * the second. `staff` and `performance` have one export each.
 *
 * **2. `reports.view` and `data.export` are checked independently, and the export routes do not
 * check `reports.view` at all.** `PermissionsGuard` resolves with `Reflector.getAllAndOverride`, so
 * the method-level `@RequirePermission("data.export")` REPLACES the controller-level
 * `@RequirePermission("reports.view")` rather than adding to it. `AnalyticsService` then re-checks
 * the same permission itself, per route, deliberately — its own comment explains that
 * `exportXCsv` must not call `getX` internally, or it would check the wrong permission for the
 * route the caller actually hit.
 *
 * Neither asymmetry is reachable through a seeded Role today: Owner, Administrator, Manager and
 * Accountant all hold **both** permissions, and Waiter holds neither, and nothing in this codebase
 * creates a Role outside `prisma/seed.ts`. So "sees but cannot export" is not a person who exists —
 * it is a response the screen must survive, because a 403 can arrive for reasons the browser does
 * not know about.
 *
 * **3. The period is a pair of calendar dates.** `from`/`to` are `YYYY-MM-DD`, read in the
 * Restaurant's own timezone, at most 366 days apart. The dates are calendar; what they select is
 * shifts. That sentence is the whole reason the screen says which cut it is showing.
 */

export interface AnalyticsSeriesPoint {
  /** The shift's business date — NOT a calendar day's takings. ADR-065. */
  date: string;
  amount: string;
}

export interface RevenueAnalytics {
  restaurantId: string;
  from: string;
  to: string;
  total: string;
  /** The server's own caption, shown verbatim: this total is bill-only sales before the platform
   * fee, not net revenue (ADR-025). Rewording it here would be a second source for one claim. */
  totalNote: string;
  series: AnalyticsSeriesPoint[];
}

export interface TipsAnalytics {
  restaurantId: string;
  from: string;
  to: string;
  total: string;
  series: AnalyticsSeriesPoint[];
}

export interface StaffAnalyticsEntry {
  membershipId: string;
  email: string;
  tips: string;
}

export interface StaffAnalyticsPage {
  restaurantId: string;
  from: string;
  to: string;
  data: StaffAnalyticsEntry[];
  meta: { page: number; limit: number; total: number; pages: number };
}

export interface PeriodTotals {
  from: string;
  to: string;
  revenue: string;
  tips: string;
  transactionCount: number;
}

export interface PerformanceAnalytics {
  restaurantId: string;
  currentPeriod: PeriodTotals;
  previousPeriod: PeriodTotals;
  /** Basis points, and `null` — never "0" — when the previous period's figure was exactly 0. A
   * change against a zero baseline has no value, and the screen must say so rather than draw a
   * flat line through it (ADR-025/026). */
  changeBasisPoints: {
    revenue: string | null;
    tips: string | null;
    transactionCount: string | null;
  };
}

export interface PeriodSummaryReport {
  restaurantId: string;
  from: string;
  to: string;
  type: "period-summary";
  revenue: string;
  revenueNote: string;
  tips: string;
  averageTipBasisPoints: string | null;
  transactionCount: number;
  topStaff: StaffAnalyticsEntry[];
}

export interface AnalyticsPeriod {
  from: string;
  to: string;
}

function range(restaurantId: string, period: AnalyticsPeriod): string {
  const params = new URLSearchParams({
    restaurantId,
    from: period.from,
    to: period.to,
  });
  return params.toString();
}

export async function fetchRevenue(
  restaurantId: string,
  period: AnalyticsPeriod,
): Promise<ApiResult<RevenueAnalytics>> {
  return await authedGet<RevenueAnalytics>(`/analytics/revenue?${range(restaurantId, period)}`);
}

export async function fetchTips(
  restaurantId: string,
  period: AnalyticsPeriod,
): Promise<ApiResult<TipsAnalytics>> {
  return await authedGet<TipsAnalytics>(`/analytics/tips?${range(restaurantId, period)}`);
}

export async function fetchStaff(
  restaurantId: string,
  period: AnalyticsPeriod,
  page = 1,
): Promise<ApiResult<StaffAnalyticsPage>> {
  return await authedGet<StaffAnalyticsPage>(
    `/analytics/staff?${range(restaurantId, period)}&page=${page}`,
  );
}

export async function fetchPerformance(
  restaurantId: string,
  period: AnalyticsPeriod,
): Promise<ApiResult<PerformanceAnalytics>> {
  return await authedGet<PerformanceAnalytics>(
    `/analytics/performance?${range(restaurantId, period)}`,
  );
}

export async function fetchReport(
  restaurantId: string,
  period: AnalyticsPeriod,
): Promise<ApiResult<PeriodSummaryReport>> {
  return await authedGet<PeriodSummaryReport>(`/analytics/reports?${range(restaurantId, period)}`);
}

/**
 * Which export cut a button asks for. Named rather than a boolean, for the reason ADR-067 gives for
 * the routes themselves: a reader of `byShift: true` has to know what the false branch means, and
 * "by shift" versus "by calendar day" has to be legible without a tooltip.
 */
export type ExportCut = "calendar" | "by-shift";

/** The areas that have an export, and which cuts each one offers. Read off the controller, not
 *  assumed to be uniform — `staff` and `performance` have no by-shift route, and asking for one
 *  would be a 404 the screen would have to explain. */
export const EXPORTS: Record<string, readonly ExportCut[]> = {
  revenue: ["calendar", "by-shift"],
  tips: ["calendar", "by-shift"],
  staff: ["calendar"],
  performance: ["calendar"],
  reports: ["calendar", "by-shift"],
};

/**
 * The export buttons an area should offer, which is two questions at once and both of them easy to
 * get wrong on their own.
 *
 * **Without the permission the answer is none, for every area.** Offering a button the server will
 * refuse teaches an owner's staff that the product is broken while it works exactly as designed
 * (`permissions.ts` argues this at length). It is presentation, never protection — the server
 * refuses regardless of what this returns.
 *
 * **With it, the answer is not uniform.** `staff` and `performance` have no `/export/by-shift`
 * route, so offering that cut for them would be a 404 the screen would then have to explain.
 */
export function exportCutsFor(area: string, mayExport: boolean): readonly ExportCut[] {
  if (!mayExport) return [];
  return EXPORTS[area] ?? [];
}

export async function fetchExportCsv(
  area: string,
  cut: ExportCut,
  restaurantId: string,
  period: AnalyticsPeriod,
): Promise<ApiResult<string>> {
  const suffix = cut === "by-shift" ? "/export/by-shift" : "/export";
  return await authedGetText(`/analytics/${area}${suffix}?${range(restaurantId, period)}`);
}

/**
 * Hands the browser a file it already has in memory.
 *
 * The CSV cannot be a plain link: the route needs an `Authorization` header, and an anchor cannot
 * carry one. So the bytes are fetched through the same renewing path as every other read, and only
 * then turned into a download — which also means a 403 is a message on the screen rather than a
 * browser tab showing JSON.
 */
export function saveCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * There is deliberately no basis-point formatter here. `lib/money.ts` already has one, and it does
 * not go through `Number` at all — it cuts the string, because a figure that has been a float, even
 * briefly, is no longer the figure the ledger holds. A second implementation on this screen would
 * be a second source for one rule, which is the drift `test/global-setup.ts` already paid for.
 */
