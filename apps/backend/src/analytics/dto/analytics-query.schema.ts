import { z } from "zod";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// API_Contract.md, ANALYTICS. `from`/`to` are plain calendar dates ("YYYY-MM-DD"), interpreted in
// the Restaurant's own timezone (ADR-026's own precedent, reused directly) — never UTC, and never
// a raw ISO timestamp, since a caller picking "a date range" means calendar days, not instants.
// Capped at 366 days (a deliberate MVP-scale tradeoff, not a forgotten limit — same "revisit only
// if this shows up in practice" reasoning as ADR-026's own DST-day caveat) so a caller can't
// request an unbounded range and force an unbounded response/query cost.
const MAX_RANGE_DAYS = 366;

function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const fromMs = Date.UTC(fy, fm - 1, fd);
  const toMs = Date.UTC(ty, tm - 1, td);
  return Math.round((toMs - fromMs) / (24 * 60 * 60 * 1000));
}

// Same two range checks applied identically to all three schemas below. Kept as three short,
// explicit .refine() chains rather than one generic wrapper — a generic constrained enough to
// keep Zod's own .default()-aware output-type inference intact fought the type checker harder
// than the duplication it would have saved is worth (CLAUDE.md: "three similar lines is better
// than a premature abstraction").
function rangeRefinements<T extends z.ZodTypeAny>(schema: T) {
  return schema
    .refine((q: { from: string; to: string }) => daysBetween(q.from, q.to) >= 0, {
      message: "from must not be after to",
      path: ["from"],
    })
    .refine((q: { from: string; to: string }) => daysBetween(q.from, q.to) < MAX_RANGE_DAYS, {
      message: `date range must not exceed ${MAX_RANGE_DAYS} days`,
      path: ["to"],
    });
}

const dateRangeFields = {
  restaurantId: z.string().uuid(),
  from: z.string().regex(ISO_DATE, "from must be YYYY-MM-DD"),
  to: z.string().regex(ISO_DATE, "to must be YYYY-MM-DD"),
};

const analyticsQueryObject = z.object(dateRangeFields);
export const analyticsQuerySchema = rangeRefinements(analyticsQueryObject);
export type AnalyticsQueryDto = z.infer<typeof analyticsQueryObject>;

// GET /analytics/staff — same range, paginated: Staff is a full list, not capped to a top N the
// way Dashboard's Top Staff is (ADR-026).
const staffAnalyticsQueryObject = z.object({
  ...dateRangeFields,
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});
export const staffAnalyticsQuerySchema = rangeRefinements(staffAnalyticsQueryObject);
export type StaffAnalyticsQueryDto = z.infer<typeof staffAnalyticsQueryObject>;

// GET /analytics/reports — same range, plus a report `type`. A real, extensible union with
// exactly one member for now, not a free-text string — the same "flexibility on demand of the
// first real case, not in advance" precedent as TipAllocationStrategy (ADR-007), PlatformFeePolicy
// (ADR-021), and the Outbox's no-handler-registry decision (ADR-024): a second report type adds a
// second enum value and a second branch, not a redesign.
const reportsQueryObject = z.object({
  ...dateRangeFields,
  type: z.enum(["period-summary"]).default("period-summary"),
});
export const reportsQuerySchema = rangeRefinements(reportsQueryObject);
export type ReportsQueryDto = z.infer<typeof reportsQueryObject>;
