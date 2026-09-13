"use client";

import { useQuery } from "@tanstack/react-query";
import { useState, type JSX } from "react";
import {
  exportCutsFor,
  fetchExportCsv,
  fetchPerformance,
  fetchReport,
  fetchRevenue,
  fetchStaff,
  fetchTips,
  saveCsv,
  type AnalyticsPeriod,
  type AnalyticsSeriesPoint,
  type ExportCut,
  type PerformanceAnalytics,
  type PeriodSummaryReport,
  type RevenueAnalytics,
  type StaffAnalyticsPage,
  type TipsAnalytics,
} from "../../../../lib/api/analytics";
import { authedGet } from "../../../../lib/auth/authed-fetch";
import { hasPermissionAtRestaurant } from "../../../../lib/auth/permissions";
import { RequireSession } from "../../../../lib/auth/require-session";
import { readSession } from "../../../../lib/auth/session";
import { t } from "../../../../lib/i18n";
import { formatBasisPoints, formatMoney, venueMoneyLocale } from "../../../../lib/money";

/**
 * Analytics — the last Portal screen, and the first one where the same data has two legitimate
 * readings.
 *
 * ── One screen, not five, and what that costs ─────────────────────────────────────────────────
 *
 * Five areas share one period, and the period is the thing a person is actually holding in their
 * head: "how did March go". Five screens would mean five copies of the date control and a period
 * that resets every time somebody moves from Revenue to Tips — the one interaction this screen
 * exists to support. It would also put five entries in a navigation bar for one idea.
 *
 * The price is a component that fetches five different shapes, which is how a screen becomes a
 * god-component. It is paid by one small component per area and one query at a time: only the
 * selected area fetches, so switching costs one request rather than five on arrival.
 *
 * The other price is a link. An area held only in React state cannot be sent to anybody, so the
 * area and the period live in the URL. `window.history.replaceState` rather than `useSearchParams`
 * deliberately: the hook forces a Suspense boundary in the App Router for a value this screen
 * already has to read on the client anyway, and the boundary would exist to satisfy the framework
 * rather than the reader.
 *
 * ── Numbers, not charts, and this is a decision rather than an omission ───────────────────────
 *
 * `revenue` and `tips` return a series of `{ date, amount }`, which is chart-shaped. **The `date`
 * is a shift's business date, not a calendar day.** Bars on a date axis read as calendar days —
 * that is what a date axis means everywhere else a person has seen one — so a chart would build
 * ADR-065's exact confusion into the picture, where the caption explaining it is not. The series is
 * a short table instead, under a heading that says "by shift".
 *
 * It is also the rule this project already holds about money: emphasis does not touch the figure,
 * and hierarchy is arithmetic. A chart is visual emphasis laid over money.
 *
 * A chart is the obvious next step — after the shift wording has been shown to land.
 *
 * ── Two emptinesses ───────────────────────────────────────────────────────────────────────────
 *
 * A period with no sales and a venue that has never sold anything are different facts and get
 * different words. The screen tells them apart by asking a second question only when the first
 * comes back empty: the widest period the API allows, 365 days. That is a proxy for "ever" and is
 * worded as one — "yet" rather than "never" — because a venue dormant for longer than a year would
 * be described wrongly by any answer this API can give.
 */

const AREAS = ["revenue", "tips", "staff", "performance", "reports"] as const;
type Area = (typeof AREAS)[number];

interface VenueScope {
  id: string;
  organizationId: string;
  currency: string;
  defaultCustomerLocale: string;
  country: string;
}

const EXPORT_PERMISSION = "data.export";
const WIDEST_PERIOD_DAYS = 365;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return isoDate(date);
}

/** Read once, on the client, so a shared link arrives showing what its sender was looking at. */
function initialState(): { area: Area; period: AnalyticsPeriod } {
  const search = typeof window === "undefined" ? "" : window.location.search;
  const params = new URLSearchParams(search);
  const area = params.get("area");
  return {
    area: AREAS.includes(area as Area) ? (area as Area) : "revenue",
    period: {
      from: params.get("from") ?? daysAgo(30),
      to: params.get("to") ?? isoDate(new Date()),
    },
  };
}

function writeUrl(area: Area, period: AnalyticsPeriod): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams({ area, from: period.from, to: period.to });
  window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
}

export function AnalyticsView({ restaurantId }: { restaurantId: string }): JSX.Element {
  return <RequireSession>{() => <Loaded id={restaurantId} />}</RequireSession>;
}

function Loaded({ id }: { id: string }): JSX.Element {
  const first = initialState();
  const [area, setArea] = useState<Area>(first.area);
  const [period, setPeriod] = useState<AnalyticsPeriod>(first.period);
  const [draft, setDraft] = useState<AnalyticsPeriod>(first.period);
  const [exportError, setExportError] = useState<string | null>(null);

  const retryUnlessRefused = (attempt: number, error: unknown): boolean => {
    const status = (error as { status?: number }).status ?? 0;
    if (status === 401 || status === 403) return false;
    return attempt < 2;
  };

  const venue = useQuery({
    queryKey: ["restaurant", id],
    queryFn: async () => {
      const result = await authedGet<VenueScope>(`/restaurants/${id}`);
      if (!result.ok) throw result.error;
      return result.data;
    },
    retry: retryUnlessRefused,
  });

  const data = useQuery({
    queryKey: ["analytics", area, id, period.from, period.to],
    queryFn: async () => {
      const result = await load(area, id, period);
      if (!result.ok) throw result.error;
      return result.data;
    },
    retry: retryUnlessRefused,
  });

  // Whether to OFFER a button, never whether the export is allowed — the server decides that and
  // would refuse regardless. Nothing on this screen breaks if it is wrong in either direction: a
  // missing button hides a capability, and a refused request is caught and worded below.
  const session = readSession();
  const mayExport = hasPermissionAtRestaurant(
    session?.memberships,
    venue.data ?? null,
    EXPORT_PERMISSION,
  );

  const cuts = exportCutsFor(area, mayExport);

  const currency = venue.data?.currency ?? "EUR";
  const moneyLocale = venueMoneyLocale(venue.data?.defaultCustomerLocale, venue.data?.country);

  function apply(): void {
    setPeriod(draft);
    writeUrl(area, draft);
  }

  function chooseArea(next: Area): void {
    setArea(next);
    setExportError(null);
    writeUrl(next, period);
  }

  async function runExport(cut: ExportCut): Promise<void> {
    setExportError(null);
    const result = await fetchExportCsv(area, cut, id, period);
    if (!result.ok) {
      setExportError(
        result.error.status === 403 ? t("analytics.export.denied") : t("analytics.export.failed"),
      );
      return;
    }
    const suffix = cut === "by-shift" ? "-by-shift" : "";
    saveCsv(`${area}${suffix}-${period.from}-${period.to}.csv`, result.data);
  }

  if (data.isError) {
    const status = (data.error as { status?: number }).status ?? 0;
    return (
      <section className="max-w-prose space-y-3" data-testid="analytics-error">
        <h1 className="text-hero-2 font-semibold">{t("analytics.title")}</h1>
        <p className="text-body text-muted">
          {status === 403 ? t("analytics.forbidden") : t("analytics.error")}
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-6" data-testid="analytics">
      <header className="space-y-2">
        <h1 className="text-hero-2 font-semibold">{t("analytics.title")}</h1>
        {/* The most load-bearing sentence here. Every figure below answers a question about shifts
            while the dates that selected them are calendar dates. */}
        <p className="max-w-prose text-body text-muted" data-testid="analytics-scope">
          {t("analytics.scope")}
        </p>
      </header>

      <PeriodPicker draft={draft} onChange={setDraft} onApply={apply} />

      <nav className="flex flex-wrap gap-2" data-testid="analytics-areas">
        {AREAS.map((each) => (
          <button
            key={each}
            type="button"
            aria-current={each === area ? "page" : undefined}
            data-testid={`analytics-area-${each}`}
            onClick={() => chooseArea(each)}
            className={`h-control rounded-portal border px-4 text-body ${
              each === area ? "border-accent text-ink" : "border-rule text-muted"
            }`}
          >
            {t(`analytics.area.${each}` as Parameters<typeof t>[0])}
          </button>
        ))}
      </nav>

      {cuts.length === 0 ? null : (
        <div className="flex flex-wrap gap-2" data-testid="analytics-exports">
          {cuts.map((cut) => (
            <button
              key={cut}
              type="button"
              data-testid={`analytics-export-${cut}`}
              onClick={() => void runExport(cut)}
              className="h-control rounded-portal border border-rule px-4 text-body"
            >
              {cut === "by-shift" ? t("analytics.export.byShift") : t("analytics.export.calendar")}
            </button>
          ))}
        </div>
      )}

      {exportError === null ? null : (
        <p className="text-body text-muted" data-testid="analytics-export-error">
          {exportError}
        </p>
      )}

      {data.isPending ? (
        <p className="text-muted">{t("analytics.loading")}</p>
      ) : (
        <AreaBody
          area={area}
          payload={data.data}
          currency={currency}
          moneyLocale={moneyLocale}
          restaurantId={id}
        />
      )}
    </section>
  );
}

function PeriodPicker({
  draft,
  onChange,
  onApply,
}: {
  draft: AnalyticsPeriod;
  onChange: (next: AnalyticsPeriod) => void;
  onApply: () => void;
}): JSX.Element {
  const inOrder = draft.from <= draft.to;
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      data-testid="analytics-period"
      onSubmit={(event) => {
        event.preventDefault();
        if (inOrder) onApply();
      }}
    >
      <label className="space-y-1 text-body">
        <span className="block text-muted">{t("analytics.period.from")}</span>
        <input
          type="date"
          value={draft.from}
          data-testid="analytics-from"
          onChange={(event) => onChange({ ...draft, from: event.target.value })}
          className="h-control rounded-portal border border-rule bg-surface px-3 text-body text-ink"
        />
      </label>
      <label className="space-y-1 text-body">
        <span className="block text-muted">{t("analytics.period.to")}</span>
        <input
          type="date"
          value={draft.to}
          data-testid="analytics-to"
          onChange={(event) => onChange({ ...draft, to: event.target.value })}
          className="h-control rounded-portal border border-rule bg-surface px-3 text-body text-ink"
        />
      </label>
      <button
        type="submit"
        disabled={!inOrder}
        data-testid="analytics-apply"
        className="h-control rounded-portal border border-accent px-4 text-body disabled:opacity-50"
      >
        {t("analytics.period.apply")}
      </button>
      {inOrder ? null : (
        <p className="text-body text-muted" data-testid="analytics-period-invalid">
          {t("analytics.period.invalid")}
        </p>
      )}
    </form>
  );
}

/** The five shapes the five areas answer with. Written out rather than inferred from `load`:
 *  the conditional-type version compiled to `never` and every field access below went with it. */
type Payload =
  | RevenueAnalytics
  | TipsAnalytics
  | StaffAnalyticsPage
  | PerformanceAnalytics
  | PeriodSummaryReport;

async function load(area: Area, id: string, period: AnalyticsPeriod) {
  switch (area) {
    case "revenue":
      return await fetchRevenue(id, period);
    case "tips":
      return await fetchTips(id, period);
    case "staff":
      return await fetchStaff(id, period);
    case "performance":
      return await fetchPerformance(id, period);
    case "reports":
      return await fetchReport(id, period);
  }
}

function AreaBody({
  area,
  payload,
  currency,
  moneyLocale,
  restaurantId,
}: {
  area: Area;
  payload: Payload | undefined;
  currency: string;
  moneyLocale: string;
  restaurantId: string;
}): JSX.Element {
  if (payload === undefined) return <p className="text-muted">{t("analytics.loading")}</p>;

  switch (area) {
    case "revenue": {
      const it = payload as RevenueAnalytics;
      return (
        <TotalWithSeries
          testId="analytics-revenue"
          label={t("analytics.revenue.total")}
          total={it.total}
          note={it.totalNote}
          series={it.series}
          currency={currency}
          moneyLocale={moneyLocale}
          restaurantId={restaurantId}
        />
      );
    }
    case "tips": {
      const it = payload as TipsAnalytics;
      return (
        <TotalWithSeries
          testId="analytics-tips"
          label={t("analytics.tips.total")}
          total={it.total}
          note={null}
          series={it.series}
          currency={currency}
          moneyLocale={moneyLocale}
          restaurantId={restaurantId}
        />
      );
    }
    case "staff":
      return (
        <StaffTable
          page={payload as StaffAnalyticsPage}
          currency={currency}
          moneyLocale={moneyLocale}
          restaurantId={restaurantId}
        />
      );
    case "performance":
      return (
        <Performance
          it={payload as PerformanceAnalytics}
          currency={currency}
          moneyLocale={moneyLocale}
        />
      );
    case "reports":
      return (
        <Report it={payload as PeriodSummaryReport} currency={currency} moneyLocale={moneyLocale} />
      );
  }
}

/**
 * Asks the one question the period-empty state cannot answer for itself.
 *
 * Only fires when the selected period is empty, so an ordinary period with sales in it costs one
 * request, not two.
 */
function EmptyState({
  restaurantId,
  moneyLocale: _moneyLocale,
}: {
  restaurantId: string;
  moneyLocale: string;
}): JSX.Element {
  const ever = useQuery({
    queryKey: ["analytics", "ever", restaurantId],
    queryFn: async () => {
      const result = await fetchRevenue(restaurantId, {
        from: daysAgo(WIDEST_PERIOD_DAYS),
        to: isoDate(new Date()),
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    retry: false,
  });

  // While the second question is in flight, the narrower and safer of the two statements: this
  // period is empty. It is true either way, and it never has to be taken back.
  if (ever.isPending || ever.isError || ever.data.series.length > 0) {
    return (
      <p className="max-w-prose text-body text-muted" data-testid="analytics-empty-period">
        {t("analytics.empty.period")}
      </p>
    );
  }

  return (
    <section className="max-w-prose space-y-2" data-testid="analytics-empty-ever">
      <p className="text-body text-ink">{t("analytics.empty.everQuestion")}</p>
      <p className="text-body text-muted">{t("analytics.empty.everBody")}</p>
    </section>
  );
}

function TotalWithSeries({
  testId,
  label,
  total,
  note,
  series,
  currency,
  moneyLocale,
  restaurantId,
}: {
  testId: string;
  label: string;
  total: string;
  note: string | null;
  series: AnalyticsSeriesPoint[];
  currency: string;
  moneyLocale: string;
  restaurantId: string;
}): JSX.Element {
  return (
    <section className="space-y-4" data-testid={testId}>
      <div className="space-y-1">
        <p className="text-body text-muted">{label}</p>
        <p className="text-hero-1 font-semibold tabular-nums" data-testid={`${testId}-total`}>
          {formatMoney(total, currency, moneyLocale)}
        </p>
        {note === null ? null : <p className="text-body text-muted">{note}</p>}
      </div>

      {series.length === 0 ? (
        <EmptyState restaurantId={restaurantId} moneyLocale={moneyLocale} />
      ) : (
        <div className="space-y-2">
          <h2 className="text-body font-semibold">{t("analytics.series.heading")}</h2>
          <table className="w-full max-w-md text-body">
            <thead>
              <tr className="text-muted">
                <th className="py-1 text-left font-normal">{t("analytics.series.date")}</th>
                <th className="py-1 text-right font-normal">{t("analytics.series.amount")}</th>
              </tr>
            </thead>
            <tbody>
              {series.map((point) => (
                <tr key={point.date} data-testid={`${testId}-point`}>
                  <td className="py-1">{point.date}</td>
                  <td className="py-1 text-right tabular-nums">
                    {formatMoney(point.amount, currency, moneyLocale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function StaffTable({
  page,
  currency,
  moneyLocale,
  restaurantId,
}: {
  page: { data: { membershipId: string; email: string; tips: string }[] };
  currency: string;
  moneyLocale: string;
  restaurantId: string;
}): JSX.Element {
  if (page.data.length === 0) {
    return <EmptyState restaurantId={restaurantId} moneyLocale={moneyLocale} />;
  }

  return (
    <section className="space-y-2" data-testid="analytics-staff">
      <h2 className="text-body font-semibold">{t("analytics.staff.heading")}</h2>
      <table className="w-full max-w-lg text-body">
        <thead>
          <tr className="text-muted">
            <th className="py-1 text-left font-normal">{t("analytics.staff.person")}</th>
            <th className="py-1 text-right font-normal">{t("analytics.staff.tips")}</th>
          </tr>
        </thead>
        <tbody>
          {page.data.map((row) => (
            <tr key={row.membershipId} data-testid="analytics-staff-row">
              <td className="py-1">{row.email}</td>
              <td className="py-1 text-right tabular-nums">
                {formatMoney(row.tips, currency, moneyLocale)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Performance({
  it,
  currency,
  moneyLocale,
}: {
  it: {
    currentPeriod: { revenue: string; tips: string; transactionCount: number };
    previousPeriod: { revenue: string; tips: string; transactionCount: number };
    changeBasisPoints: {
      revenue: string | null;
      tips: string | null;
      transactionCount: string | null;
    };
  };
  currency: string;
  moneyLocale: string;
}): JSX.Element {
  const rows: { key: string; label: string; now: string; before: string; change: string | null }[] =
    [
      {
        key: "revenue",
        label: t("analytics.revenue.total"),
        now: formatMoney(it.currentPeriod.revenue, currency, moneyLocale),
        before: formatMoney(it.previousPeriod.revenue, currency, moneyLocale),
        change: it.changeBasisPoints.revenue,
      },
      {
        key: "tips",
        label: t("analytics.tips.total"),
        now: formatMoney(it.currentPeriod.tips, currency, moneyLocale),
        before: formatMoney(it.previousPeriod.tips, currency, moneyLocale),
        change: it.changeBasisPoints.tips,
      },
      {
        key: "transactions",
        label: t("analytics.performance.transactions"),
        now: String(it.currentPeriod.transactionCount),
        before: String(it.previousPeriod.transactionCount),
        // The API computes this one too. An earlier version passed `null` here and rendered the
        // zero-baseline sentence — so the screen said "nothing was taken in the period before"
        // directly beside the 40 payments taken in the period before. Found by looking at the
        // demo fixture, which is what the fixture is for: no test asserted this row's wording,
        // and both halves of the contradiction were individually correct.
        change: it.changeBasisPoints.transactionCount,
      },
    ];

  return (
    <section className="space-y-2" data-testid="analytics-performance">
      <table className="w-full max-w-2xl text-body">
        <thead>
          <tr className="text-muted">
            <th className="py-1 text-left font-normal" />
            <th className="py-1 text-right font-normal">{t("analytics.performance.current")}</th>
            <th className="py-1 text-right font-normal">{t("analytics.performance.previous")}</th>
            <th className="py-1 text-right font-normal">{t("analytics.performance.change")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} data-testid={`analytics-performance-${row.key}`}>
              <td className="py-1 text-muted">{row.label}</td>
              <td className="py-1 text-right tabular-nums">{row.now}</td>
              <td className="py-1 text-right tabular-nums">{row.before}</td>
              <td className="py-1 text-right tabular-nums">
                {/* `null` is not zero and must never be drawn as a flat 0% — there was no baseline
                    to compare against, and saying "no change" would be a claim nobody made. */}
                {row.change === null ? (
                  <span className="text-muted">{t("analytics.performance.noBaseline")}</span>
                ) : (
                  formatBasisPoints(row.change, moneyLocale)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Report({
  it,
  currency,
  moneyLocale,
}: {
  it: {
    revenue: string;
    revenueNote: string;
    tips: string;
    averageTipBasisPoints: string | null;
    transactionCount: number;
    topStaff: { membershipId: string; email: string; tips: string }[];
  };
  currency: string;
  moneyLocale: string;
}): JSX.Element {
  return (
    <section className="space-y-4" data-testid="analytics-report">
      <dl className="grid max-w-lg grid-cols-2 gap-y-2 text-body">
        <dt className="text-muted">{t("analytics.revenue.total")}</dt>
        <dd className="text-right tabular-nums">
          {formatMoney(it.revenue, currency, moneyLocale)}
        </dd>
        <dt className="text-muted">{t("analytics.tips.total")}</dt>
        <dd className="text-right tabular-nums">{formatMoney(it.tips, currency, moneyLocale)}</dd>
        <dt className="text-muted">{t("analytics.report.transactions")}</dt>
        <dd className="text-right tabular-nums">{it.transactionCount}</dd>
        <dt className="text-muted">{t("analytics.report.averageTip")}</dt>
        <dd className="text-right tabular-nums">
          {it.averageTipBasisPoints === null
            ? t("analytics.report.noAverage")
            : formatBasisPoints(it.averageTipBasisPoints, moneyLocale)}
        </dd>
      </dl>
      <p className="max-w-prose text-body text-muted">{it.revenueNote}</p>

      {it.topStaff.length === 0 ? null : (
        <div className="space-y-2">
          <h2 className="text-body font-semibold">{t("analytics.report.topStaff")}</h2>
          <table className="w-full max-w-lg text-body">
            <tbody>
              {it.topStaff.map((row) => (
                <tr key={row.membershipId} data-testid="analytics-report-top-row">
                  <td className="py-1">{row.email}</td>
                  <td className="py-1 text-right tabular-nums">
                    {formatMoney(row.tips, currency, moneyLocale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
