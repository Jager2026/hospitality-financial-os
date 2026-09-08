"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { JSX } from "react";
import { authedGet } from "../../../../../lib/auth/authed-fetch";
import { RequireSession } from "../../../../../lib/auth/require-session";
import { t } from "../../../../../lib/i18n";
import { formatMoney, venueMoneyLocale } from "../../../../../lib/money";
import { clockTime, statusLabel } from "../transactions-view";

/**
 * One transaction, broken down — the screen that answers *where did this money go*.
 *
 * **Why it is a page rather than an expanding row.** The breakdown is a second request the list
 * does not make (`GET /transactions/{id}`), and it is the thing an owner forwards to their
 * accountant when a figure is queried; a link can be forwarded and a expanded row cannot. The row
 * says which payment. This says what became of it.
 *
 * **`processingFee` is absent on purpose and is not an oversight** (ADR-025): Stripe deducts it
 * from the connected account's balance, and our webhook never observes it. A `0` there would be a
 * false figure in a financial breakdown, so the field is `null` and nothing renders — the same
 * "null, never zero" rule the Dashboard's Average Tip already follows.
 */
interface TransactionDetail {
  id: string;
  restaurantId: string;
  grossAmount: string;
  currency: string;
  status: string;
  createdAt: string;
  netRestaurantRevenue: string;
  netTip: string;
  netPlatformFee: string;
  tax: string | null;
  processingFee: string | null;
  refundedAmount: string;
  refunds: Array<{
    id: string;
    amount: string;
    reason: string;
    tipRefunded: boolean;
    status: string;
    createdAt: string;
  }>;
  chargebacks: Array<{
    id: string;
    amount: string;
    reason: string;
    status: string;
    resolvedAt: string | null;
    createdAt: string;
  }>;
}

interface VenueForDisplay {
  currency: string;
  country: string;
  defaultCustomerLocale: string;
  timezone: string;
}

export function TransactionDetailView({
  restaurantId,
  transactionId,
}: {
  restaurantId: string;
  transactionId: string;
}): JSX.Element {
  return (
    <RequireSession>
      {() => <Loaded restaurantId={restaurantId} transactionId={transactionId} />}
    </RequireSession>
  );
}

function Loaded({
  restaurantId,
  transactionId,
}: {
  restaurantId: string;
  transactionId: string;
}): JSX.Element {
  const venue = useQuery({
    queryKey: ["restaurant", restaurantId],
    queryFn: async () => {
      const result = await authedGet<VenueForDisplay>(`/restaurants/${restaurantId}`);
      if (!result.ok) throw result.error;
      return result.data;
    },
    retry: false,
  });

  const detail = useQuery({
    queryKey: ["transaction", transactionId],
    queryFn: async () => {
      const result = await authedGet<TransactionDetail>(`/transactions/${transactionId}`);
      if (!result.ok) throw result.error;
      return result.data;
    },
    retry: (attempt: number, error: unknown) => {
      const status = (error as { status?: number }).status ?? 0;
      if (status === 401 || status === 403 || status === 404) return false;
      return attempt < 2;
    },
  });

  if (detail.isPending) return <p className="text-muted">{t("transactions.loading")}</p>;

  if (detail.isError) {
    const status = (detail.error as { status?: number }).status ?? 0;
    return (
      <section className="max-w-prose space-y-3" data-testid="transaction-detail-error">
        <h1 className="text-hero-2 font-semibold">{t("transaction.error.title")}</h1>
        {/* 404 here is deliberately ambiguous at the API — a transaction the caller may not read
            answers the same way as one that does not exist (#109's disclosure rule) — so the
            wording must not claim to know which. */}
        <p className="text-muted">
          {status === 404 ? t("transaction.error.notFound") : t("transactions.error.explain")}
        </p>
        <Link
          href={`/restaurants/${restaurantId}/transactions`}
          className="inline-block rounded-portal border border-rule px-4 py-2 text-small"
        >
          {t("transaction.back")}
        </Link>
      </section>
    );
  }

  const d = detail.data;
  const locale = venueMoneyLocale(venue.data?.defaultCustomerLocale, venue.data?.country);
  const currency = venue.data?.currency ?? d.currency;
  const money = (amount: string): string => formatMoney(amount, currency, locale);

  return (
    <div className="max-w-prose space-y-8" data-testid="transaction-detail">
      <header className="space-y-2">
        <p className="text-small text-muted">{clockTime(d.createdAt, venue.data?.timezone)}</p>
        <h1 className="text-hero-2 font-semibold">{money(d.grossAmount)}</h1>
        <p className="text-small uppercase text-faint" data-testid="transaction-status">
          {statusLabel(d.status)}
        </p>
      </header>

      {/* The whole reason this screen exists: the bill split into who got what. */}
      <dl className="space-y-3" data-testid="transaction-breakdown">
        <Line label={t("transaction.line.restaurant")} value={money(d.netRestaurantRevenue)} />
        <Line label={t("transaction.line.tip")} value={money(d.netTip)} />
        <Line label={t("transaction.line.platformFee")} value={money(d.netPlatformFee)} />
        <Line
          label={t("transaction.line.tax")}
          value={d.tax === null ? t("transaction.unavailable") : money(d.tax)}
        />
        {/* Unavailable, never 0 (ADR-025) — and said in words rather than left blank, because a
            blank in a money breakdown reads as zero. */}
        <Line
          label={t("transaction.line.processingFee")}
          value={d.processingFee === null ? t("transaction.unavailable") : money(d.processingFee)}
        />
      </dl>

      {d.refunds.length > 0 ? (
        <section className="space-y-2" data-testid="transaction-refunds">
          <h2 className="text-title">{t("transaction.refunds.title")}</h2>
          <ul className="space-y-2">
            {d.refunds.map((r) => (
              <li key={r.id} className="text-small text-muted">
                {`${clockTime(r.createdAt, venue.data?.timezone)} · ${money(r.amount)} · ${r.reason}`}
                {/* ADR-062: a refund returns the bill and the tip stays with the waiter, so
                    whether the tip went back is a fact worth showing rather than assuming. */}
                {r.tipRefunded ? ` · ${t("transaction.refunds.tipReturned")}` : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {d.chargebacks.length > 0 ? (
        <section className="space-y-2" data-testid="transaction-chargebacks">
          <h2 className="text-title">{t("transaction.chargebacks.title")}</h2>
          <ul className="space-y-2">
            {d.chargebacks.map((c) => (
              <li key={c.id} className="text-small text-muted">
                {`${clockTime(c.createdAt, venue.data?.timezone)} · ${money(c.amount)} · ${c.reason} · ${c.status}`}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Link
        href={`/restaurants/${restaurantId}/transactions`}
        className="inline-block text-small text-muted underline"
      >
        {t("transaction.back")}
      </Link>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-6 border-b border-rule pb-2">
      <dt className="text-small text-muted">{label}</dt>
      <dd className="text-body">{value}</dd>
    </div>
  );
}
