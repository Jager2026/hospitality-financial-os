"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState, type JSX } from "react";
import { authedGet, authedPost } from "../../../../lib/auth/authed-fetch";
import {
  hasPermissionAtRestaurant,
  STRIPE_ONBOARDING_PERMISSION,
} from "../../../../lib/auth/permissions";
import { RequireSession } from "../../../../lib/auth/require-session";
import { readSession } from "../../../../lib/auth/session";
import { t } from "../../../../lib/i18n";

/**
 * Connect Payments — the screen that takes a Restaurant from "exists" to "can take money".
 *
 * Stripe hosts the identity and bank-account collection; this screen's whole job is to say where
 * the venue stands, hand the person off, and receive them back (`UX_MAP.md`).
 *
 * ── Why the link is requested on a click and never on load ─────────────────────────────────────
 *
 * **A Stripe Account Link is single-use and short-lived — five minutes, measured against a real
 * account on 2026-09-02 (#125), not read in documentation.** Mail clients that follow links to
 * scan them burn one without anybody intending to, which is why "the owner has a link" and "the
 * link still works" are different facts.
 *
 * Requesting one when the screen loads would therefore mint a link on every visit, spend a slot
 * from a budget of ten per hour, and mostly produce links nobody uses. It is minted when a person
 * asks for it and used immediately.
 *
 * ── Three sources, three questions, and none of them answers another's ─────────────────────────
 *
 * The Dashboard banner reads the two Stripe **capabilities**, because it asks *can this venue take
 * money right now*.
 *
 * This screen reads `onboardingStatus` for two of its states, because that derived value is the
 * only thing that separates *Stripe is waiting on the owner* (`IN_PROGRESS`) from *Stripe is
 * reviewing and wants nothing* (`RESTRICTED`) — and telling somebody to go and finish a form when
 * nothing is asked of them is the worse of the two errors.
 *
 * And it reads **our own `onboardingLinkFirstRequestedAt`** to choose between starting and
 * continuing, because no Stripe field can. A venue seconds old is already `IN_PROGRESS`: creation
 * requests card_payments, so Stripe attaches requirements immediately. Choosing on the status told
 * every new owner to resume something they had never begun.
 *
 * This comment previously said the screen's states *are* `onboardingStatus`. That was true when
 * written and stopped being true here; it is corrected rather than left, because a file's own
 * header is the last place anyone checks for a stale claim.
 */
interface RestaurantOnboarding {
  id: string;
  organizationId: string;
  name: string;
  onboardingStatus: string;
  cardPaymentsStatus: string | null;
  payoutsStatus: string | null;
  /** When a Stripe link was first minted for this venue; `null` means never. See below. */
  onboardingLinkFirstRequestedAt: string | null;
}

export function ConnectPayments({
  restaurantId,
  arrival,
}: {
  restaurantId: string;
  /** How the person got here. `returned` and `expired` are Stripe's own two return URLs. */
  arrival: "direct" | "returned" | "expired";
}): JSX.Element {
  return <RequireSession>{() => <Loaded id={restaurantId} arrival={arrival} />}</RequireSession>;
}

type LinkState =
  | { phase: "idle" }
  | { phase: "requesting" }
  | { phase: "refused"; reason: "rate-limited" | "not-allowed" | "unavailable" };

function Loaded({
  id,
  arrival,
}: {
  id: string;
  arrival: "direct" | "returned" | "expired";
}): JSX.Element {
  const [link, setLink] = useState<LinkState>({ phase: "idle" });

  const restaurant = useQuery({
    queryKey: ["restaurant", id],
    queryFn: async () => {
      const result = await authedGet<RestaurantOnboarding>(`/restaurants/${id}`);
      if (!result.ok) throw result.error;
      return result.data;
    },
    retry: (attempt: number, error: unknown) => {
      const status = (error as { status?: number }).status ?? 0;
      if (status === 401 || status === 403 || status === 404) return false;
      return attempt < 2;
    },
  });

  if (restaurant.isPending) return <p className="text-muted">{t("connect.loading")}</p>;

  if (restaurant.isError) {
    const status = (restaurant.error as { status?: number }).status ?? 0;
    return (
      <Panel testId="connect-error" title={t("connect.error.title")}>
        <p className="text-muted">
          {status === 401 ? t("dashboard.expired.explain") : t("connect.error.explain")}
        </p>
        {status === 401 ? <ActionLink href="/login" label={t("dashboard.expired.action")} /> : null}
      </Panel>
    );
  }

  const venue = restaurant.data;
  const allowed = hasPermissionAtRestaurant(
    readSession()?.memberships,
    venue,
    STRIPE_ONBOARDING_PERMISSION,
  );

  // COMPLETE is the one state with nothing to offer, and offering it anyway would invite an owner
  // to redo work that is finished. The screen confirms and points at the Dashboard instead.
  if (venue.onboardingStatus === "COMPLETE") {
    return (
      <Panel testId="connect-complete" title={t("connect.complete.title")}>
        <p className="text-muted">{t("connect.complete.explain")}</p>
        <ActionLink href={`/restaurants/${venue.id}`} label={t("connect.complete.action")} />
      </Panel>
    );
  }

  // RESTRICTED means blocked with nothing outstanding for the owner to do — a review at Stripe's
  // end. `UX_MAP.md` is explicit that this state must "stop asking for action", and a button here
  // would be asking somebody to fix something that is not theirs to fix.
  if (venue.onboardingStatus === "RESTRICTED") {
    return (
      <Panel testId="connect-under-review" title={t("connect.review.title")}>
        <p className="text-muted">{t("connect.review.explain")}</p>
        <QuietLink href={`/restaurants/${venue.id}`} label={t("connect.later")} />
      </Panel>
    );
  }

  /**
   * Start or continue — and this reads OUR column, not Stripe's status, because Stripe's status
   * cannot answer it.
   *
   * `onboardingStatus` is `IN_PROGRESS` on a venue seconds old: `POST /restaurants` requests
   * card_payments, so Stripe attaches requirements immediately (18 of them, measured on a real
   * account). Deriving "continue where you left off" from that told every new owner to resume
   * something they had never begun. `NOT_STARTED` cannot rescue it either — that value is
   * unreachable for anything this product creates, surviving only on rows never refreshed.
   *
   * The distinguishing fact is ours: a link was minted for this venue, or it was not.
   *
   * **What this still does not know**, and the wording stays inside that limit: whether the link
   * was opened, whether Stripe's form was reached, whether anything was filled in. It knows the
   * form was handed over. "Asked for a link" and "started onboarding" are different questions.
   */
  const resuming = venue.onboardingLinkFirstRequestedAt !== null;

  return (
    <Panel
      testId="connect-payments"
      title={resuming ? t("connect.resume.title") : t("connect.start.title")}
    >
      {arrival === "expired" ? (
        <p className="text-small text-muted" data-testid="connect-link-expired">
          {t("connect.expired.explain")}
        </p>
      ) : null}
      {arrival === "returned" ? (
        <p className="text-small text-muted" data-testid="connect-returned">
          {t("connect.returned.explain")}
        </p>
      ) : null}

      <p className="text-muted">
        {resuming ? t("connect.resume.explain") : t("connect.start.explain")}
      </p>

      {/* What Stripe will ask for, and why. Written here rather than fetched, and the reason has
          been corrected by measurement: #179 said `requirementsDue` had never been populated in
          this system. That was true then and is false now — creating a venue through the real
          screen on 2026-09-08 produced an account carrying **18** entries.

          The decision not to render them stands, on the evidence rather than on its absence: each
          entry's `description` is an API field path — `configuration.merchant.mcc` — not prose a
          person can act on. Turning eighteen of those into instructions needs a mapping from
          Stripe's field names to human words that we do not have, and that Stripe's own hosted
          onboarding already performs. Listing what Stripe asks of every business is true without
          pretending to translate this venue's eighteen. */}
      <ul className="list-disc space-y-1 pl-5 text-small text-muted">
        <li>{t("connect.asks.identity")}</li>
        <li>{t("connect.asks.business")}</li>
        <li>{t("connect.asks.bank")}</li>
      </ul>

      {allowed ? (
        <RequestLink restaurantId={venue.id} resuming={resuming} state={link} setState={setLink} />
      ) : (
        <p className="text-small text-muted" data-testid="connect-not-allowed">
          {t("connect.notAllowed.explain")}
        </p>
      )}

      {/* Postponing is allowed and must be visible (`UX_MAP.md`): a venue that exists but cannot
          yet take cards is normal for hours or days, not a failure. */}
      <QuietLink href={`/restaurants/${venue.id}`} label={t("connect.later")} />
    </Panel>
  );
}

/**
 * The button, and the three refusals it has to be able to explain.
 *
 * **A 429 is not a fault.** The route allows ten links an hour from one address (#125), which is
 * far more than an honest owner needs and is a real ceiling all the same — burned links, a
 * scanning mail client, or a second person in the same office. Rendered as a breakage it would
 * read as "the product is down"; it is a wait, and the screen says so.
 *
 * **A 404 here means one of three things, and the screen deliberately does not guess which.** The
 * backend answers `RESTAURANT_NOT_FOUND` for a venue the caller cannot reach, for a caller without
 * `restaurant.create`, and for a venue with no Stripe account yet — one code for three causes
 * (#125's own reasoning: confirming a venue exists is itself a disclosure). Since the status above
 * loaded, the venue is reachable; the remaining two are what the message covers, without claiming
 * to know which.
 */
function RequestLink({
  restaurantId,
  resuming,
  state,
  setState,
}: {
  restaurantId: string;
  resuming: boolean;
  state: LinkState;
  setState: (next: LinkState) => void;
}): JSX.Element {
  async function request(): Promise<void> {
    setState({ phase: "requesting" });
    const result = await authedPost<{ url: string }>(
      `/restaurants/${restaurantId}/onboarding-link`,
    );

    if (result.ok) {
      // Straight out to Stripe. The link is single-use and minutes old; storing it, or rendering
      // it as an anchor for later, is what makes a dead link look like a live one.
      window.location.href = result.data.url;
      return;
    }

    const status = result.error.status;
    setState({
      phase: "refused",
      reason: status === 429 ? "rate-limited" : status === 404 ? "not-allowed" : "unavailable",
    });
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => void request()}
        disabled={state.phase === "requesting"}
        data-testid="connect-continue"
        className="rounded-portal border border-rule px-4 py-2 text-small disabled:opacity-60"
      >
        {state.phase === "requesting"
          ? t("connect.action.working")
          : resuming
            ? t("connect.action.resume")
            : t("connect.action.start")}
      </button>

      {state.phase === "refused" ? (
        <p className="max-w-prose text-small text-muted" data-testid={`connect-${state.reason}`}>
          {state.reason === "rate-limited"
            ? t("connect.refused.rateLimited")
            : state.reason === "not-allowed"
              ? t("connect.refused.notAllowed")
              : t("connect.refused.unavailable")}
        </p>
      ) : null}
    </div>
  );
}

function Panel({
  testId,
  title,
  children,
}: {
  testId: string;
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="max-w-prose space-y-4" data-testid={testId}>
      <h1 className="text-hero-2 font-semibold">{title}</h1>
      {children}
    </section>
  );
}

function ActionLink({ href, label }: { href: string; label: string }): JSX.Element {
  return (
    <Link
      href={href}
      className="inline-block rounded-portal border border-rule px-4 py-2 text-small"
    >
      {label}
    </Link>
  );
}

/**
 * Postponing, weighted as the secondary action it is.
 *
 * Hierarchy by size and weight rather than colour (DESIGN_SYSTEM.md, ADR-072). Given the same
 * bordered box as the primary, "I will do this later" reads as an equal choice — and looked at on
 * the real screen, that is exactly how it read.
 */
function QuietLink({ href, label }: { href: string; label: string }): JSX.Element {
  return (
    <Link href={href} className="inline-block text-small text-muted underline">
      {label}
    </Link>
  );
}
