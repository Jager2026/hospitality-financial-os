"use client";

import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { fetchLatestClosedShiftSummary, type ShiftCloseSummary } from "../../../lib/api/shifts";
import { t } from "../../../lib/i18n";
import { formatMoney } from "../../../lib/money";

/**
 * ADR-096 — the one line a closed shift is for.
 *
 * **One question, one answer: how much, and when does it arrive.** Everything else is below it and
 * smaller, because a screen that gives equal weight to five figures answers nothing.
 *
 * **Two dates stay two lines.** `available_on` is midnight UTC of the charge's UTC date plus the
 * account's payout delay, and UTC midnight falls at 03:00 Vilnius in summer and 02:00 in winter —
 * so a venue trading past those hours genuinely has two arrival dates for one evening. Adding them
 * together would print a date the money does not arrive on.
 *
 * **"Available", never "in your account".** Stripe makes funds available on that date; the payout
 * then travels on the account's own schedule and the bank takes its own time. We can promise the
 * first and not the second, so the sentence promises only the first.
 */
export function ShiftCloseAnswer({
  restaurantId,
  currency,
  locale,
}: {
  restaurantId: string;
  currency: string;
  locale: string;
}): JSX.Element | null {
  const query = useQuery({
    queryKey: ["shift-close-answer", restaurantId],
    queryFn: async () => {
      const result = await fetchLatestClosedShiftSummary(restaurantId);
      if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
      return result.data;
    },
    retry: (attempt: number, error: unknown) => {
      const status = (error as { status?: number }).status ?? 0;
      if (status === 401 || status === 403) return false;
      return attempt < 2;
    },
  });

  // A venue that has never closed a shift has nothing to answer, and an unreachable endpoint must
  // not put an error where a figure belongs — the rest of the dashboard is still true.
  if (query.isPending || query.isError || query.data === null || query.data === undefined) {
    return null;
  }

  const summary = query.data;
  return (
    <section className="space-y-3" data-testid="shift-close-answer">
      <p className="text-label uppercase text-faint">{t("shiftClose.title")}</p>
      <Arrival summary={summary} currency={currency} locale={locale} />
      <Breakdown summary={summary} currency={currency} locale={locale} />
    </section>
  );
}

function Arrival({
  summary,
  currency,
  locale,
}: {
  summary: ShiftCloseSummary;
  currency: string;
  locale: string;
}): JSX.Element {
  if (summary.availability.rows.length === 0) {
    return (
      <p className="text-title" data-testid="shift-close-arrival-none">
        {summary.availability.state === "pending"
          ? t("shiftClose.counting")
          : t("shiftClose.neverKnown")}
      </p>
    );
  }

  return (
    <ul className="space-y-1" data-testid="shift-close-arrivals">
      {summary.availability.rows.map((row) => (
        <li key={row.availableOn} className="text-title font-semibold tabular-nums">
          {t("shiftClose.arrival")
            .replace("{amount}", formatMoney(row.amount, currency, locale))
            .replace("{date}", arrivalDate(row.availableOn, locale))}
        </li>
      ))}
      {summary.availability.unresolved > 0 ? (
        <li className="text-small text-muted" data-testid="shift-close-unresolved">
          {(summary.availability.state === "pending"
            ? t("shiftClose.stillCounting")
            : t("shiftClose.someNeverKnown")
          ).replace("{count}", String(summary.availability.unresolved))}
        </li>
      ) : null}
    </ul>
  );
}

/** Below and smaller, on purpose: these explain the figure above rather than compete with it. */
function Breakdown({
  summary,
  currency,
  locale,
}: {
  summary: ShiftCloseSummary;
  currency: string;
  locale: string;
}): JSX.Element {
  const stripeFee = summary.deductions.find((d) => d.kind === "stripe_processing");
  const platformFee = summary.deductions.find((d) => d.kind === "platform_fee");
  const show = (amount: string | null): string =>
    amount === null ? t("shiftClose.unknown") : formatMoney(amount, currency, locale);

  return (
    <dl className="space-y-1 text-small text-muted" data-testid="shift-close-breakdown">
      <Row label={t("shiftClose.gross")} value={show(summary.grossRevenue.amount)} />
      <Row label={t("shiftClose.tips")} value={show(summary.tips.amount)} />
      <Row label={t("shiftClose.stripeFee")} value={show(stripeFee?.amount ?? null)} />
      <Row label={t("shiftClose.platformFee")} value={show(platformFee?.amount ?? null)} />
      <Row label={t("shiftClose.net")} value={show(summary.netToVenue.amount)} />
    </dl>
  );
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex justify-between gap-6">
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

/** The date Stripe stated, rendered in the venue's own language rather than as an ISO string. */
function arrivalDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(iso));
}
