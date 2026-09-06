"use client";

import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { apiGetAuthed } from "../../../lib/api/client";
import { RequireSession } from "../../../lib/auth/require-session";
import { t } from "../../../lib/i18n";
import { formatBasisPoints, formatMoney } from "../../../lib/money";

/** The subset of `DashboardSummary` this screen reads. Money arrives as minor-unit strings. */
interface DashboardSummary {
  restaurantId: string;
  shift: {
    id: string;
    businessDate: string;
    openedAt: string;
    closedAt: string | null;
    closedAfterMidnight: boolean;
    afterMidnightRevenue: string;
  } | null;
  shiftRevenue: string;
  shiftRevenueNote: string;
  shiftTips: string;
  averageTipBasisPoints: string | null;
  shiftTransactions: number;
  averageBill: string | null;
  recentPayments: { currency: string }[];
}

/** The subset of `GET /restaurants/:id` the banner reads (ADR-063). */
interface RestaurantSummary {
  id: string;
  name: string;
  currency: string;
  payoutsStatus: string | null;
}

export function DashboardView({ restaurantId }: { restaurantId: string }): JSX.Element {
  return (
    <RequireSession>
      {(session) => <Loaded token={session.accessToken} id={restaurantId} />}
    </RequireSession>
  );
}

function Loaded({ token, id }: { token: string; id: string }): JSX.Element {
  // TWO CALLS, DELIBERATELY (ADR-063). Every figure below is computed from our own Ledger; the
  // payout banner is a cached observation of Stripe. Folding them into one response would make
  // the most-viewed screen in the product fail whenever Stripe is unavailable — so the banner is
  // allowed to be missing while the numbers are not.
  // A REFUSAL IS NOT A BLIP. TanStack retries a failed query three times by default, which is
  // right for a dropped connection and wrong for 401 or 403: an authorization decision does not
  // become a different decision by being asked again, and the retries only delay the moment the
  // screen can tell the person what happened. Found by a test waiting five seconds for an error
  // state that was still backing off.
  const retryUnlessRefused = (attempt: number, error: unknown): boolean => {
    const status = (error as { status?: number }).status ?? 0;
    if (status === 401 || status === 403) return false;
    return attempt < 2;
  };

  const summary = useQuery({
    queryKey: ["dashboard", id],
    queryFn: async () => {
      const result = await apiGetAuthed<DashboardSummary>(`/dashboard?restaurantId=${id}`, token);
      if (!result.ok) throw result.error;
      return result.data;
    },
    retry: retryUnlessRefused,
  });

  const restaurant = useQuery({
    queryKey: ["restaurant", id],
    queryFn: async () => {
      const result = await apiGetAuthed<RestaurantSummary>(`/restaurants/${id}`, token);
      if (!result.ok) throw result.error;
      return result.data;
    },
    retry: retryUnlessRefused,
  });

  if (summary.isPending) {
    return <p className="text-muted">{t("dashboard.loading")}</p>;
  }

  if (summary.isError) {
    const error = summary.error as { code?: string };
    const message =
      error.code === "NETWORK_UNAVAILABLE"
        ? t("dashboard.error.unreachable")
        : error.code === "PERMISSION_DENIED"
          ? t("dashboard.error.forbidden")
          : t("dashboard.error.title");
    return (
      <section className="max-w-prose space-y-3" data-testid="dashboard-error">
        <h1 className="text-hero-2 font-semibold">{t("dashboard.error.title")}</h1>
        <p className="text-muted">{message}</p>
        <button
          type="button"
          onClick={() => void summary.refetch()}
          className="rounded-portal border border-rule px-4 py-2 text-small"
        >
          {t("dashboard.error.retry")}
        </button>
      </section>
    );
  }

  const data = summary.data;
  const currency = restaurant.data?.currency ?? data.recentPayments[0]?.currency ?? "EUR";

  return (
    <div className="space-y-8" data-testid="dashboard">
      <Header name={restaurant.data?.name ?? null} shift={data.shift} />
      {restaurant.data?.payoutsStatus != null && restaurant.data.payoutsStatus !== "active" ? (
        <PayoutsBanner />
      ) : null}
      {data.shift === null ? (
        <Explanation titleKey="dashboard.noShift.title" explainKey="dashboard.noShift.explain" />
      ) : data.shiftTransactions === 0 ? (
        <Explanation titleKey="dashboard.empty.title" explainKey="dashboard.empty.explain" />
      ) : (
        <Figures data={data} currency={currency} />
      )}
    </div>
  );
}

function Header({
  name,
  shift,
}: {
  name: string | null;
  shift: DashboardSummary["shift"];
}): JSX.Element {
  return (
    <header className="space-y-2">
      {/* Rank 1 by SIZE, never by colour — the accent is nowhere near a figure or a heading
          (DESIGN_SYSTEM.md, and ADR-072's rule that the accent never carries meaning). */}
      <h1 className="text-hero-2 font-semibold">{name ?? t("dashboard.title")}</h1>
      {shift === null ? null : (
        <p className="text-small text-muted" data-testid="shift-line">
          {t("dashboard.shift.businessDate")} {shift.businessDate} · {t("dashboard.shift.openedAt")}{" "}
          <time dateTime={shift.openedAt}>{clockTime(shift.openedAt)}</time>
          {shift.closedAt === null ? ` · ${t("dashboard.shift.open")}` : ""}
        </p>
      )}
    </header>
  );
}

function Figures({ data, currency }: { data: DashboardSummary; currency: string }): JSX.Element {
  return (
    <>
      <section className="space-y-1" data-testid="revenue">
        <p className="text-label uppercase text-faint">{t("dashboard.revenue")}</p>
        {/* THE hero figure. 48px against a 16px body is the Hierarchy Law made arithmetic: no
            other element on this screen may exceed 30px, so a second rank-1 is impossible. */}
        <p className="text-hero font-semibold tabular-nums">
          {formatMoney(data.shiftRevenue, currency)}
        </p>
        <p className="text-micro uppercase text-faint">{data.shiftRevenueNote}</p>
      </section>

      <section className="grid gap-6 sm:grid-cols-3">
        <Figure label={t("dashboard.tips")} value={formatMoney(data.shiftTips, currency)} />
        <Figure
          label={t("dashboard.averageBill")}
          value={data.averageBill === null ? "—" : formatMoney(data.averageBill, currency)}
        />
        <Figure
          label={t("dashboard.averageTip")}
          value={
            data.averageTipBasisPoints === null
              ? "—"
              : formatBasisPoints(data.averageTipBasisPoints)
          }
        />
      </section>

      {/* ADR-065's central figure, and it is an EXPLANATION rather than a warning. A shift closing
          at 01:30 is an ordinary Saturday; what is not ordinary is a Z-report and a bank statement
          disagreeing with nothing on screen to say why. */}
      {data.shift !== null && data.shift.closedAfterMidnight ? (
        <section
          className="max-w-prose space-y-1 border-t border-rule pt-6"
          data-testid="after-midnight"
        >
          <p className="text-label uppercase text-faint">{t("dashboard.afterMidnight.title")}</p>
          <p className="text-title tabular-nums">
            {formatMoney(data.shift.afterMidnightRevenue, currency)}
          </p>
          <p className="text-small text-muted">{t("dashboard.afterMidnight.explain")}</p>
        </section>
      ) : null}
    </>
  );
}

function Figure({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="space-y-1">
      <p className="text-label uppercase text-faint">{label}</p>
      <p className="text-title tabular-nums">{value}</p>
    </div>
  );
}

/**
 * The empty state, which is not decoration.
 *
 * MASTERPLAN: calm is achieved by explanation, never by omission — a screen of zeros makes a quiet
 * morning and a broken terminal look identical, and the owner cannot tell which one they are
 * having.
 */
function Explanation({
  titleKey,
  explainKey,
}: {
  titleKey: "dashboard.empty.title" | "dashboard.noShift.title";
  explainKey: "dashboard.empty.explain" | "dashboard.noShift.explain";
}): JSX.Element {
  return (
    <section className="max-w-prose space-y-2" data-testid="dashboard-empty">
      <p className="text-title">{t(titleKey)}</p>
      <p className="text-muted">{t(explainKey)}</p>
    </section>
  );
}

function PayoutsBanner(): JSX.Element {
  return (
    <section
      className="max-w-prose space-y-1 rounded-portal border border-rule bg-surface-2 p-4"
      data-testid="payouts-banner"
    >
      <p className="text-small font-medium">{t("dashboard.stripe.title")}</p>
      <p className="text-small text-muted">{t("dashboard.stripe.explain")}</p>
    </section>
  );
}

/** 16:00, not a timestamp. The shift's own clock time is what an owner recognises. */
function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IE", { hour: "2-digit", minute: "2-digit" });
}
