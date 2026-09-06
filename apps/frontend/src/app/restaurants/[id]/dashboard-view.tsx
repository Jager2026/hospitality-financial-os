"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { JSX } from "react";
import { apiGetAuthed } from "../../../lib/api/client";
import { RequireSession } from "../../../lib/auth/require-session";
import { t } from "../../../lib/i18n";
import { formatBasisPoints, formatMoney, venueMoneyLocale } from "../../../lib/money";

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

/** The subset of `GET /restaurants/:id` this screen reads (ADR-063). */
interface RestaurantSummary {
  id: string;
  name: string;
  currency: string;
  country: string;
  defaultCustomerLocale: string;
  payoutsStatus: string | null;
}

/**
 * The language the screen is READ in, which is not the locale money is WRITTEN in.
 *
 * ADR-040: the Portal ships in English. So a weekday name is English, while `1 240,00 €` follows
 * the venue (DESIGN_SYSTEM.md, Money formatting). Rendering the date in the venue's locale would
 * put "rugsėjo 6 d., sekmadienis" in the middle of an otherwise English screen — the mistake this
 * separation exists to prevent, and the one a later "make it consistent" change would make.
 */
const READING_LOCALE = "en-IE";

export function DashboardView({ restaurantId }: { restaurantId: string }): JSX.Element {
  return (
    <RequireSession>
      {(session) => <Loaded token={session.accessToken} id={restaurantId} />}
    </RequireSession>
  );
}

function Loaded({ token, id }: { token: string; id: string }): JSX.Element {
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

  // TWO CALLS, DELIBERATELY (ADR-063). Every figure below is computed from our own Ledger; the
  // payout banner is a cached observation of Stripe. Folding them into one response would make
  // the most-viewed screen in the product fail whenever Stripe is unavailable — so the banner is
  // allowed to be missing while the numbers are not.
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
    return <Failure error={summary.error} onRetry={() => void summary.refetch()} />;
  }

  const data = summary.data;
  const currency = restaurant.data?.currency ?? data.recentPayments[0]?.currency ?? "EUR";
  const moneyLocale = venueMoneyLocale(
    restaurant.data?.defaultCustomerLocale,
    restaurant.data?.country,
  );

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
        <Figures data={data} currency={currency} locale={moneyLocale} />
      )}
    </div>
  );
}

/**
 * What the screen says when it has nothing to show.
 *
 * **An expired session is the common case, and it used to read as a broken server.** The access
 * token lives fifteen minutes and nothing refreshes it (ADR-076), so every state of this screen
 * fails identically once a person leaves it open. That is exactly how it was reported: two
 * dashboards "broken", one working, and the only difference was which had been opened first.
 *
 * The title said *"We could not load this dashboard"* and the body repeated the same words, so the
 * one thing the reader could do about it — sign in again — was the one thing never mentioned. The
 * second line now says what happened; when the session is what ended, the action is a link rather
 * than a retry button, because retrying is precisely what will not work.
 */
function Failure({ error, onRetry }: { error: unknown; onRetry: () => void }): JSX.Element {
  const status = (error as { status?: number }).status ?? 0;
  const code = (error as { code?: string }).code;
  const expired = status === 401;

  const explain = expired
    ? t("dashboard.expired.explain")
    : code === "NETWORK_UNAVAILABLE"
      ? t("dashboard.error.unreachable")
      : status === 403
        ? t("dashboard.error.forbidden")
        : t("dashboard.error.explain");

  return (
    <section className="max-w-prose space-y-3" data-testid="dashboard-error">
      <h1 className="text-hero-2 font-semibold">
        {expired ? t("dashboard.expired.title") : t("dashboard.error.title")}
      </h1>
      <p className="text-muted" data-testid="dashboard-error-explain">
        {explain}
      </p>
      {expired ? (
        <Link
          href="/login"
          className="inline-block rounded-portal border border-rule px-4 py-2 text-small"
        >
          {t("dashboard.expired.action")}
        </Link>
      ) : (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-portal border border-rule px-4 py-2 text-small"
        >
          {t("dashboard.error.retry")}
        </button>
      )}
    </section>
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
          <time dateTime={shift.businessDate}>{humanDate(shift.businessDate)}</time>
          {" · "}
          {/* A CLOSED SHIFT NOW SAYS SO. It read "Shift opened 16:00" and stopped, so a finished
              working day looked like an open one minus a phrase — on a screen whose entire job is
              naming which working day it means. */}
          <time dateTime={shift.openedAt}>{clockTime(shift.openedAt)}</time>
          {shift.closedAt === null ? (
            <> · {t("dashboard.shift.open")}</>
          ) : (
            <>
              {" – "}
              <time dateTime={shift.closedAt}>{clockTime(shift.closedAt)}</time>
            </>
          )}
        </p>
      )}
    </header>
  );
}

function Figures({
  data,
  currency,
  locale,
}: {
  data: DashboardSummary;
  currency: string;
  locale: string;
}): JSX.Element {
  return (
    <>
      <section className="space-y-1" data-testid="revenue">
        <p className="text-label uppercase text-faint">{t("dashboard.revenue")}</p>
        {/* THE hero figure. 48px against a 16px body is the Hierarchy Law made arithmetic: no
            other element on this screen may exceed 30px, so a second rank-1 is impossible. */}
        <p className="text-hero font-semibold tabular-nums">
          {formatMoney(data.shiftRevenue, currency, locale)}
        </p>
        <p className="text-micro uppercase text-faint">{data.shiftRevenueNote}</p>
      </section>

      <section className="grid gap-6 sm:grid-cols-3">
        <Figure label={t("dashboard.tips")} value={formatMoney(data.shiftTips, currency, locale)} />
        <Figure
          label={t("dashboard.averageBill")}
          value={data.averageBill === null ? "—" : formatMoney(data.averageBill, currency, locale)}
        />
        <Figure
          label={t("dashboard.averageTip")}
          value={
            data.averageTipBasisPoints === null
              ? "—"
              : formatBasisPoints(data.averageTipBasisPoints, locale)
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
            {formatMoney(data.shift.afterMidnightRevenue, currency, locale)}
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
  return new Date(iso).toLocaleTimeString(READING_LOCALE, { hour: "2-digit", minute: "2-digit" });
}

/**
 * "Sunday, 6 September" rather than "2026-09-06".
 *
 * Rendered in UTC deliberately: the business date is a LABEL the venue gave its working day
 * (ADR-064), not an instant. Formatting it in the reader's own timezone would shift it by a day
 * for anyone west of the venue and rename a working day that already has a name.
 */
function humanDate(businessDate: string): string {
  return new Date(`${businessDate}T00:00:00Z`).toLocaleDateString(READING_LOCALE, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}
