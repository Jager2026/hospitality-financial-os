"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState, type JSX } from "react";
import { authedGet } from "../../../../lib/auth/authed-fetch";
import { RequireSession } from "../../../../lib/auth/require-session";
import { t } from "../../../../lib/i18n";
import { formatMoney, venueMoneyLocale } from "../../../../lib/money";

/**
 * Transactions — where an owner goes when a figure on the Dashboard raised a question.
 *
 * ── Two things this screen cannot do, established from the API rather than assumed ─────────────
 *
 * **1. It is not shift-scoped, and it cannot be.** ADR-065 says operational screens read shifts.
 * `Transaction` carries no `shiftId` and no link to `Shift`; `Payment` does not either; only
 * `LedgerLine` does. `GET /transactions` accepts `restaurantId`, `status`, `membership`, `page`
 * and `limit` — no shift, no date — and returns `createdAt` and nothing else time-shaped. So this
 * list is every transaction for the venue, newest first, and calling it "this shift" would be a
 * claim the data cannot support. Recorded in `UX_API_RECONCILIATION.md`; closing it is a backend
 * change and this slice does not make one.
 *
 * **2. It cannot name the waiter.** `TransactionListEntry` has no membership and no display name,
 * though the *filter* takes a `membership` uuid. A filter by a person the rows cannot name is a
 * filter nobody can read the result of, so it is not offered here.
 *
 * ── What the row shows, and why the card exists ────────────────────────────────────────────────
 *
 * The row answers **which payment**: when, how much, how much of it was a tip, and whether
 * anything happened to it since. Four fields, because four is what the list endpoint returns.
 *
 * The card answers **where the money went** — the split into the venue's share, the tip, the
 * platform fee and tax, plus any refunds and chargebacks. That is a second request
 * (`GET /transactions/{id}`) and a genuinely different question, which is why it is a page of its
 * own rather than an expanding row: it is the thing an owner sends to their accountant, and a link
 * can be sent.
 */
interface TransactionRow {
  id: string;
  grossAmount: string;
  currency: string;
  tip: string;
  status: string;
  createdAt: string;
}

interface TransactionPage {
  data: TransactionRow[];
  meta: { page: number; limit: number; total: number; pages: number };
}

/** The subset of `GET /restaurants/:id` this screen reads: money is written in the venue's locale,
 * and an instant is read in the venue's clock (ADR-064's reasoning about whose day it is). */
interface VenueForDisplay {
  id: string;
  name: string;
  currency: string;
  country: string;
  defaultCustomerLocale: string;
  timezone: string;
}

/** The four values `transactionListQuerySchema` accepts. Not a free-text box: an unknown status is
 * a 400 from the API, and a filter that can produce one is a filter that teaches people to
 * distrust the screen. */
const STATUSES = ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED", "DISPUTED"] as const;
type StatusFilter = (typeof STATUSES)[number] | "";

const READING_LOCALE = "en-IE";

export function TransactionsView({ restaurantId }: { restaurantId: string }): JSX.Element {
  return <RequireSession>{() => <Loaded id={restaurantId} />}</RequireSession>;
}

function Loaded({ id }: { id: string }): JSX.Element {
  const [status, setStatus] = useState<StatusFilter>("");
  const [page, setPage] = useState(1);

  const venue = useQuery({
    queryKey: ["restaurant", id],
    queryFn: async () => {
      const result = await authedGet<VenueForDisplay>(`/restaurants/${id}`);
      if (!result.ok) throw result.error;
      return result.data;
    },
    retry: retryUnlessRefused,
  });

  // PAGE-BASED, because that is what the endpoint does: `page`/`limit`, and a `meta` carrying the
  // total and the page count. Infinite scroll would be a second paging model layered on the
  // first — and it is the wrong one here anyway, since somebody checking a figure wants to be able
  // to say which page they were on.
  const list = useQuery({
    queryKey: ["transactions", id, status, page],
    queryFn: async () => {
      const query = new URLSearchParams({ restaurantId: id, page: String(page) });
      if (status !== "") query.set("status", status);
      const result = await authedGet<TransactionPage>(`/transactions?${query.toString()}`);
      if (!result.ok) throw result.error;
      return result.data;
    },
    retry: retryUnlessRefused,
  });

  if (list.isPending) return <p className="text-muted">{t("transactions.loading")}</p>;
  if (list.isError) return <Failure error={list.error} onRetry={() => void list.refetch()} />;

  const moneyLocale = venueMoneyLocale(venue.data?.defaultCustomerLocale, venue.data?.country);
  const currency = venue.data?.currency ?? list.data.data[0]?.currency ?? "EUR";
  const timezone = venue.data?.timezone;
  const filtered = status !== "";

  return (
    <div className="space-y-6" data-testid="transactions">
      <header className="space-y-2">
        <h1 className="text-hero-2 font-semibold">{t("transactions.title")}</h1>
        {/* Said once, plainly, rather than implied by an absent filter: this is every transaction
            for the venue, not the open shift. The Dashboard is the screen that reads shifts. */}
        <p className="text-small text-muted" data-testid="transactions-scope">
          {t("transactions.scope")}
        </p>
      </header>

      <label className="block space-y-1">
        <span className="block text-small">{t("transactions.filter.status")}</span>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as StatusFilter);
            // Back to the first page: page 4 of an unfiltered list is rarely page 4 of a filtered
            // one, and an empty page 4 reads as "nothing here" rather than "wrong page".
            setPage(1);
          }}
          data-testid="transactions-status"
          className="h-control rounded-portal border border-rule bg-surface px-3 text-body text-ink"
        >
          <option value="">{t("transactions.filter.any")}</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {statusLabel(value)}
            </option>
          ))}
        </select>
      </label>

      {list.data.data.length === 0 ? (
        <Empty filtered={filtered} onClear={() => setStatus("")} />
      ) : (
        <>
          <ul className="divide-y divide-rule border-y border-rule" data-testid="transactions-list">
            {list.data.data.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/restaurants/${id}/transactions/${row.id}`}
                  className="flex items-baseline justify-between gap-6 py-3"
                  data-testid="transaction-row"
                >
                  <span className="space-y-1">
                    <span className="block text-body">{clockTime(row.createdAt, timezone)}</span>
                    <span className="block text-micro uppercase text-faint">
                      {statusLabel(row.status)}
                    </span>
                  </span>
                  <span className="space-y-1 text-right">
                    <span className="block text-title">
                      {formatMoney(row.grossAmount, currency, moneyLocale)}
                    </span>
                    <span className="block text-small text-muted">
                      {t("transactions.row.tip")} {formatMoney(row.tip, currency, moneyLocale)}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>

          <Pages meta={list.data.meta} onPage={setPage} />
        </>
      )}
    </div>
  );
}

/**
 * Two empty states, and keeping them apart is the point.
 *
 * A quiet shift and a filter that matched nothing look identical if both render "no transactions",
 * and they mean opposite things: one says the venue has taken no money, the other says the venue
 * may have taken plenty and this question excluded it. The Dashboard already refuses to show a
 * zero without an explanation (`MASTERPLAN`); this is the same rule applied to a list, plus the
 * distinction a list can make and a figure cannot.
 */
function Empty({ filtered, onClear }: { filtered: boolean; onClear: () => void }): JSX.Element {
  if (filtered) {
    return (
      <section className="max-w-prose space-y-3" data-testid="transactions-empty-filter">
        <p className="text-title">{t("transactions.emptyFilter.title")}</p>
        <p className="text-muted">{t("transactions.emptyFilter.explain")}</p>
        <button
          type="button"
          onClick={onClear}
          data-testid="transactions-clear-filter"
          className="rounded-portal border border-rule px-4 py-2 text-small"
        >
          {t("transactions.emptyFilter.action")}
        </button>
      </section>
    );
  }
  return (
    <section className="max-w-prose space-y-2" data-testid="transactions-empty">
      <p className="text-title">{t("transactions.empty.title")}</p>
      <p className="text-muted">{t("transactions.empty.explain")}</p>
    </section>
  );
}

/** Page numbers, not an infinite list — the endpoint counts pages and a person checking a figure
 * needs to be able to come back to the same one. */
function Pages({
  meta,
  onPage,
}: {
  meta: TransactionPage["meta"];
  onPage: (page: number) => void;
}): JSX.Element | null {
  if (meta.pages <= 1) return null;
  return (
    <nav className="flex items-center gap-4" data-testid="transactions-pages">
      <button
        type="button"
        disabled={meta.page <= 1}
        onClick={() => onPage(meta.page - 1)}
        data-testid="transactions-prev"
        className="rounded-portal border border-rule px-3 py-1 text-small disabled:opacity-40"
      >
        {t("transactions.pages.previous")}
      </button>
      <span className="text-small text-muted" data-testid="transactions-page-of">
        {`${meta.page} / ${meta.pages}`}
      </span>
      <button
        type="button"
        disabled={meta.page >= meta.pages}
        onClick={() => onPage(meta.page + 1)}
        data-testid="transactions-next"
        className="rounded-portal border border-rule px-3 py-1 text-small disabled:opacity-40"
      >
        {t("transactions.pages.next")}
      </button>
    </nav>
  );
}

function Failure({ error, onRetry }: { error: unknown; onRetry: () => void }): JSX.Element {
  const status = (error as { status?: number }).status ?? 0;
  const expired = status === 401;
  // 403 is the one worth its own words here: the list requires `reports.view`, which a Waiter does
  // not hold, so "you cannot see this" is the true answer rather than "something went wrong".
  const explain = expired
    ? t("dashboard.expired.explain")
    : status === 403
      ? t("transactions.error.forbidden")
      : t("transactions.error.explain");

  return (
    <section className="max-w-prose space-y-3" data-testid="transactions-error">
      <h1 className="text-hero-2 font-semibold">
        {expired ? t("dashboard.expired.title") : t("transactions.error.title")}
      </h1>
      <p className="text-muted">{explain}</p>
      {expired ? (
        <Link
          href="/login"
          className="inline-block rounded-portal border border-rule px-4 py-2 text-small"
        >
          {t("dashboard.expired.action")}
        </Link>
      ) : status === 403 ? null : (
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

function retryUnlessRefused(attempt: number, error: unknown): boolean {
  const status = (error as { status?: number }).status ?? 0;
  if (status === 401 || status === 403 || status === 404) return false;
  return attempt < 2;
}

/**
 * The venue's clock, not the reader's.
 *
 * A payment at 01:30 belongs to the venue's night (ADR-064), and an owner checking it from another
 * country must see the time their staff would name. Rendered in the Restaurant's own timezone when
 * the venue loaded; falls back to the reader's zone rather than showing nothing, since the list
 * survives the second request failing (ADR-063's rule about the Dashboard applies here too).
 */
function clockTime(iso: string, timezone: string | undefined): string {
  return new Date(iso).toLocaleString(READING_LOCALE, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    ...(timezone === undefined ? {} : { timeZone: timezone }),
  });
}

/** Stripe-shaped enum values are not words a person reads. The dictionary owns the wording. */
function statusLabel(status: string): string {
  switch (status) {
    case "COMPLETED":
      return t("transactions.status.completed");
    case "PARTIALLY_REFUNDED":
      return t("transactions.status.partiallyRefunded");
    case "REFUNDED":
      return t("transactions.status.refunded");
    case "DISPUTED":
      return t("transactions.status.disputed");
    default:
      return status;
  }
}

export { clockTime, statusLabel };
