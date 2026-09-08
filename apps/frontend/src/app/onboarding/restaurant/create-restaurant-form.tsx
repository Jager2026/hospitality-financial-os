"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type JSX } from "react";
import { authedGet, authedPost } from "../../../lib/auth/authed-fetch";
import { RequireSession } from "../../../lib/auth/require-session";
import { readSession } from "../../../lib/auth/session";
import { t } from "../../../lib/i18n";

/**
 * Create Your Restaurant — the last gap between registering and a working Dashboard.
 *
 * ── What this screen must get right, and it is not the form ────────────────────────────────────
 *
 * **`POST /restaurants` creates a real Stripe Connect account BEFORE it opens a transaction**
 * (`restaurant.service.ts`), so a failure inside that transaction leaves an account at Stripe with
 * no row referencing it. Measured on 2026-09-07 rather than reasoned about: with the Owner role
 * temporarily renamed so the transaction would throw, the endpoint answered **500**, the database
 * held **zero** restaurants, organizations and memberships — and Stripe held
 * `acct_1UD9t9B7fPGPwOhy`, orphaned. Closing it took a hand-written v2 API call, because the
 * product has no path to an account no row points at.
 *
 * The API's own words on that 500 are *"Something went wrong. Please try again."* **Trying again
 * mints a second account.** So this screen must never turn an ambiguous failure into a second
 * create, and that is the one rule the rest of the error handling is built around:
 *
 *   - a refusal we can read — 400, 403, 404, 409 — created nothing, so retrying is safe;
 *   - a failure with an unknown outcome — no response at all, or a 5xx — **may have succeeded**,
 *     so the screen asks `GET /restaurants` what actually exists before offering anything. If a
 *     restaurant is there, it goes on to payment setup; only if there is none does it offer
 *     another attempt.
 *
 * ── Which endpoint, and why it is a decision rather than plumbing ──────────────────────────────
 *
 * Two routes create a Restaurant, and they carry different permissions:
 *
 *   - `POST /restaurants` — no Permission at all, deliberately (`restaurant.controller.ts`): a
 *     just-registered person holds zero Memberships, so there is nothing to check a Permission
 *     against. It creates a NEW Organization and makes the caller its org-wide Owner.
 *   - `POST /organizations/{id}/restaurants` — requires `restaurant.create` **in that
 *     Organization**, which is what stops a Manager or a Waiter adding a venue to their employer.
 *
 * So the choice of route *is* the permission decision. Somebody holding an org-wide Membership is
 * adding a venue to their own chain and goes through the scoped route, where the server checks
 * them. Somebody holding none is starting their own business and goes through the bootstrap route,
 * which is exactly what it exists for.
 */

interface CreatedRestaurant {
  id: string;
}

/** The launch market is decided (ADR-012: Lithuania, EUR) and both are **permanent** for a
 * Restaurant — they are fixed at Stripe account creation and changing either means a new
 * Restaurant, not an edit (`DATABASE.md`). Shown as settled values with that reason next to them,
 * rather than as pickers offering choices the platform has not decided it supports. */
const LAUNCH_COUNTRY = "LT";
const LAUNCH_CURRENCY = "EUR";

const FIELD_CLASS =
  "h-control w-full rounded-portal border border-rule bg-surface px-3 text-body text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent";

export function CreateRestaurantForm(): JSX.Element {
  return <RequireSession>{() => <Form />}</RequireSession>;
}

/**
 * What the screen does after a failure it cannot attribute.
 *
 * `retry` is the ordinary case — the server said no, nothing was written. `verify` is the one that
 * matters: the request may have created a restaurant and a Stripe account, so the only honest next
 * step is to look.
 */
type Refusal =
  { kind: "none" } | { kind: "retry"; message: string } | { kind: "verify"; message: string };

function Form(): JSX.Element {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [refusal, setRefusal] = useState<Refusal>({ kind: "none" });

  const [name, setName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [companyNumber, setCompanyNumber] = useState("");
  const [vatNumber, setVatNumber] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  // The browser knows where it is, and the venue is almost always where the person filling this in
  // is. Editable, because "almost always" is not always.
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Vilnius",
  );

  const memberships = readSession()?.memberships ?? [];
  const orgWide = memberships.filter((m) => m.restaurantId === null);

  // More than one org-wide Membership means more than one chain, and this screen has no way to ask
  // which one is meant — there is no organization picker anywhere in the Portal yet. Guessing would
  // write a Restaurant into the wrong Organization, which is not an edit anybody can undo.
  if (orgWide.length > 1) {
    return (
      <section className="max-w-prose space-y-3" data-testid="create-restaurant-ambiguous">
        <h1 className="text-hero-2 font-semibold">{t("createRestaurant.ambiguous.title")}</h1>
        <p className="text-muted">{t("createRestaurant.ambiguous.explain")}</p>
      </section>
    );
  }

  const organizationId = orgWide[0]?.organizationId ?? null;
  const path =
    organizationId === null ? "/restaurants" : `/organizations/${organizationId}/restaurants`;

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setRefusal({ kind: "none" });

    const result = await authedPost<CreatedRestaurant>(path, {
      name,
      legalName,
      companyNumber,
      vatNumber,
      email,
      phone,
      address,
      timezone,
      country: LAUNCH_COUNTRY,
      currency: LAUNCH_CURRENCY,
      defaultCustomerLocale: "en",
    });

    if (result.ok) {
      // NOT the Dashboard. The venue exists and cannot take a card yet, so a Dashboard would open
      // on a banner saying so; payment setup is the actual next step (#179).
      router.push(`/restaurants/${result.data.id}/onboarding`);
      return;
    }

    const status = result.error.status;
    // 0 means no response reached us at all, and a 5xx means the server broke somewhere it cannot
    // describe — in both cases the write may or may not have happened.
    const outcomeUnknown = status === 0 || status >= 500;
    setSubmitting(false);
    setRefusal(
      outcomeUnknown
        ? { kind: "verify", message: t("createRestaurant.error.unknownOutcome") }
        : {
            kind: "retry",
            message:
              status === 403 || status === 404
                ? t("createRestaurant.error.notAllowed")
                : status === 400
                  ? t("createRestaurant.error.rejected")
                  : t("createRestaurant.error.refused"),
          },
    );
  }

  /** The only safe move after an ambiguous failure: ask what exists rather than write again. */
  async function verify(): Promise<void> {
    setSubmitting(true);
    const result = await authedGet<{ id: string; name: string }[]>("/restaurants");
    setSubmitting(false);
    if (!result.ok) return; // still cannot tell; the message stays and so does this button

    const created = result.data.find((r) => r.name === name);
    if (created) {
      router.push(`/restaurants/${created.id}/onboarding`);
      return;
    }
    setRefusal({ kind: "retry", message: t("createRestaurant.error.verifiedAbsent") });
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="max-w-prose space-y-6" noValidate>
      <header className="space-y-2">
        <h1 className="text-hero-2 font-semibold">{t("createRestaurant.title")}</h1>
        <p className="text-muted">{t("createRestaurant.explain")}</p>
      </header>

      <div className="space-y-4" data-testid="create-restaurant-form">
        <Field id="name" label={t("createRestaurant.field.name")} value={name} onChange={setName} />
        <Field
          id="legalName"
          label={t("createRestaurant.field.legalName")}
          hint={t("createRestaurant.hint.legalName")}
          value={legalName}
          onChange={setLegalName}
        />
        <Field
          id="companyNumber"
          label={t("createRestaurant.field.companyNumber")}
          value={companyNumber}
          onChange={setCompanyNumber}
        />
        <Field
          id="vatNumber"
          label={t("createRestaurant.field.vatNumber")}
          value={vatNumber}
          onChange={setVatNumber}
        />
        <Field
          id="email"
          type="email"
          label={t("createRestaurant.field.email")}
          hint={t("createRestaurant.hint.email")}
          value={email}
          onChange={setEmail}
        />
        <Field
          id="phone"
          label={t("createRestaurant.field.phone")}
          value={phone}
          onChange={setPhone}
        />
        <Field
          id="address"
          label={t("createRestaurant.field.address")}
          value={address}
          onChange={setAddress}
        />
        <Field
          id="timezone"
          label={t("createRestaurant.field.timezone")}
          hint={t("createRestaurant.hint.timezone")}
          value={timezone}
          onChange={setTimezone}
        />

        {/* Permanent, and said where the choice would otherwise be made silently. */}
        <p className="text-small text-muted" data-testid="create-restaurant-fixed">
          {t("createRestaurant.fixed")}
        </p>
      </div>

      {refusal.kind !== "none" ? (
        <p
          className="max-w-prose text-small text-muted"
          data-testid={
            refusal.kind === "verify" ? "create-restaurant-unknown" : "create-restaurant-error"
          }
        >
          {refusal.message}
        </p>
      ) : null}

      {/* After an ambiguous failure the submit button is GONE, not merely disabled: the only
          offered action is to find out what happened. A disabled-then-enabled button is exactly
          how a second Stripe account gets created. */}
      {refusal.kind === "verify" ? (
        <button
          type="button"
          onClick={() => void verify()}
          disabled={submitting}
          data-testid="create-restaurant-verify"
          className="rounded-portal border border-rule px-4 py-2 text-small disabled:opacity-60"
        >
          {submitting ? t("createRestaurant.action.checking") : t("createRestaurant.action.check")}
        </button>
      ) : (
        <button
          type="submit"
          disabled={submitting}
          data-testid="create-restaurant-submit"
          className="rounded-portal border border-rule px-4 py-2 text-small disabled:opacity-60"
        >
          {submitting ? t("createRestaurant.action.working") : t("createRestaurant.action.create")}
        </button>
      )}
    </form>
  );
}

function Field({
  id,
  label,
  hint,
  value,
  onChange,
  type = "text",
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (next: string) => void;
  type?: string;
}): JSX.Element {
  return (
    <label htmlFor={id} className="block space-y-1">
      <span className="block text-small">{label}</span>
      {hint === undefined ? null : <span className="block text-micro text-faint">{hint}</span>}
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        className={FIELD_CLASS}
      />
    </label>
  );
}
