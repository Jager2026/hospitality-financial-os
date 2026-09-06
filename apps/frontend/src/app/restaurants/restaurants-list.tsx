"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { JSX } from "react";
import { authedGet } from "../../lib/auth/authed-fetch";
import { RequireSession } from "../../lib/auth/require-session";
import { t } from "../../lib/i18n";

/**
 * The subset of `GET /restaurants` this screen reads.
 *
 * **One call, and that is a design decision rather than a convenience.** Everything a row shows is
 * already in this response — established by calling the endpoint, not by reading the service. The
 * two candidates that are NOT here, an open shift and its revenue, would each cost a
 * `GET /dashboard` per row: an N+1 on a screen whose entire job is choosing which link to click.
 */
interface RestaurantRow {
  id: string;
  name: string;
  address: string;
  onboardingStatus: string;
  cardPaymentsStatus: string | null;
}

/**
 * One row: stacked on a phone, side by side from `sm` up.
 *
 * The breakpoint is here because the screen was looked at rather than reasoned about. At 375px the
 * flag pill takes nearly half the width, and holding it on the same line as the name pushed every
 * name onto three wrapped lines — legible, and unpleasant enough that an owner would stop using
 * the screen from a phone.
 */
const ROW =
  "flex flex-col items-start gap-2 py-4 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6";

export function RestaurantsList(): JSX.Element {
  return <RequireSession>{() => <Loaded />}</RequireSession>;
}

function Loaded(): JSX.Element {
  const query = useQuery({
    queryKey: ["restaurants"],
    queryFn: async () => {
      const result = await authedGet<RestaurantRow[]>("/restaurants");
      if (!result.ok) throw result.error;
      return result.data;
    },
    retry: (attempt: number, error: unknown) => {
      const status = (error as { status?: number }).status ?? 0;
      if (status === 401 || status === 403) return false;
      return attempt < 2;
    },
  });

  if (query.isPending) return <p className="text-muted">{t("restaurants.loading")}</p>;

  if (query.isError) {
    const status = (query.error as { status?: number }).status ?? 0;
    const expired = status === 401;
    return (
      <section className="max-w-prose space-y-3" data-testid="restaurants-error">
        <h1 className="text-hero-2 font-semibold">
          {expired ? t("dashboard.expired.title") : t("restaurants.error.title")}
        </h1>
        <p className="text-muted">
          {expired ? t("dashboard.expired.explain") : t("restaurants.error.explain")}
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
            onClick={() => void query.refetch()}
            className="rounded-portal border border-rule px-4 py-2 text-small"
          >
            {t("dashboard.error.retry")}
          </button>
        )}
      </section>
    );
  }

  if (query.data.length === 0) return <NoRestaurants />;

  return (
    <div className="space-y-6" data-testid="restaurants">
      <h1 className="text-hero-2 font-semibold">{t("restaurants.title")}</h1>
      <ul className="divide-y divide-rule border-y border-rule">
        {query.data.map((restaurant) => (
          <li key={restaurant.id}>
            <Link
              href={`/restaurants/${restaurant.id}`}
              className={ROW}
              data-testid="restaurant-row"
            >
              <span className="space-y-1">
                <span className="block text-title">{restaurant.name}</span>
                <span className="block text-small text-muted">{restaurant.address}</span>
              </span>
              <PaymentsState restaurant={restaurant} />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The one thing worth showing beside a name, and the reasoning is about cost as much as value.
 *
 * **What it answers:** whether this venue can take a card right now. A restaurant that cannot is
 * the only case where the answer changes what the owner should do next, and it is exactly the fact
 * they would otherwise discover by opening the dashboard and reading a banner — one click too late.
 *
 * **What it costs: nothing.** `onboardingStatus` and `cardPaymentsStatus` are already on the row.
 * The alternatives — is a shift open, what has it taken — are not, and each would add a
 * `GET /dashboard` per restaurant.
 *
 * **What it deliberately ignores: `payoutsStatus`.** A venue that can charge a card but cannot yet
 * pay out is still trading — the money accumulates and reaches the bank later — so it is not a
 * reason to pick a different venue, which is the only decision this screen supports. The Dashboard
 * already says it, in a banner, to the person who has opened that venue. Adding it here would put a
 * second flag on a navigation row for a state that changes nothing about which row to click.
 *
 * **What it is NOT:** live. `GET /restaurants` returns our cached view of Stripe; only
 * `GET /restaurants/:id` re-reads it (`refreshStripeStatus`). That is the right way round, and the
 * same reasoning as ADR-063 — a navigation screen must not fail or hang because Stripe is slow.
 *
 * **And there is no "Closed" state here, which is a finding rather than an omission.** A first
 * draft had one. Reading the WRITE path rather than the read path showed it could never render:
 * the only code that sets `Restaurant.status = INACTIVE` is `RestaurantService.close`, which sets
 * `deletedAt` in the same statement (ADR-054), and `findAllForUser` filters `deletedAt: null`.
 * `PATCH /restaurants/:id` cannot set `status` at all — `createRestaurantSchema`, which the update
 * schema is derived from, has no such field. So a closed venue is absent from this response, not
 * present-and-marked. **If that ever separates — a venue closed for the season but not removed —
 * this is the branch to add back, and it needs the API to return it first.**
 */
function PaymentsState({ restaurant }: { restaurant: RestaurantRow }): JSX.Element | null {
  if (restaurant.cardPaymentsStatus === "active") return null;
  return (
    <Flag
      testId="restaurant-cannot-take-cards"
      label={
        restaurant.onboardingStatus === "NOT_STARTED"
          ? t("restaurants.flag.setupNotStarted")
          : t("restaurants.flag.cannotTakeCards")
      }
    />
  );
}

/**
 * A word, not a colour.
 *
 * ADR-072's rule is that the accent never carries meaning, and a red pill would be worse than
 * useless here: an owner whose second venue is mid-onboarding is not in an incident. The state is
 * ordinary and the screen says it in words.
 */
function Flag({ testId, label }: { testId: string; label: string }): JSX.Element {
  return (
    <span
      className="shrink-0 rounded-portal border border-rule px-3 py-1 text-micro uppercase text-faint"
      data-testid={testId}
    >
      {label}
    </span>
  );
}

/**
 * No restaurants at all — a brand-new owner, seconds after registering.
 *
 * **This is the first screen of the product for that person**, and an empty list would be the
 * worst possible one: nothing to read, nothing to do, and no evidence that signing up worked. So
 * it leads somewhere. MASTERPLAN's rule applies exactly as it does to the Dashboard's quiet
 * morning — calm comes from explanation, never from an absence the reader has to interpret.
 */
function NoRestaurants(): JSX.Element {
  return (
    <section className="max-w-prose space-y-3" data-testid="restaurants-empty">
      <h1 className="text-hero-2 font-semibold">{t("restaurants.empty.title")}</h1>
      <p className="text-muted">{t("restaurants.empty.explain")}</p>
      <Link
        href="/onboarding/restaurant"
        className="inline-block rounded-portal border border-rule px-4 py-2 text-small"
        data-testid="create-first-restaurant"
      >
        {t("restaurants.empty.action")}
      </Link>
    </section>
  );
}
