import { AppException } from "../exceptions/app.exception";

/**
 * The revision of each agreement a new acceptance is recorded against (ADR-049).
 *
 * The value below is a placeholder, and it is written to be **unmistakable in the data itself**
 * rather than to look plausible. A date string would produce acceptance rows that appear to name a
 * published revision; anyone reading the table in six months would have no way to tell that no such
 * document existed. This value says so, in every row it writes.
 *
 * **The pre-pilot gate (`IMPLEMENTATION_PLAN.md`): the registration screen must not be shown to a
 * real restaurant while this is still the placeholder.** An acceptance pointing at a text that does
 * not exist is not a missing record — it is a false one, asserting that someone agreed to a
 * document nobody can produce. That is worse than recording nothing.
 *
 * Checking the gate needs no tooling: this constant either is the placeholder or it is not.
 */
export const PLATFORM_TERMS_PLACEHOLDER = "UNPUBLISHED-no-terms-document-exists-yet";

/** Subject: User. Accepted at registration and at invitation acceptance. */
export const CURRENT_PLATFORM_TERMS_VERSION = PLATFORM_TERMS_PLACEHOLDER;

/**
 * Subject: Restaurant. Accepted when its Stripe connected account is created — Stripe's own
 * template has the account holder agree to the Connected Account Agreement *through* the
 * platform's terms, and the account holder is the business (ADR-049).
 */
export const CURRENT_STRIPE_AGREEMENT_VERSION = PLATFORM_TERMS_PLACEHOLDER;

/**
 * The pre-pilot gate, enforced by the API rather than by the screen (ADR-055).
 *
 * **The gate existed and did not hold, and the reason is worth stating exactly.** It was written
 * as *"the registration screen must not be shown to a real restaurant"* — a rule about a screen.
 * `POST /auth/register` went on accepting requests regardless, so anything reaching the route
 * directly still wrote an acceptance naming a document that does not exist. That is not
 * hypothetical: one such row existed on production, written from a real browser, and was removed
 * by hand. **A gate that protects a screen protects nothing; the route is the thing that writes.**
 *
 * Refusal, not a warning — the same shape as ADR-050. A warning next to a write that happens
 * anyway is the state this replaces.
 *
 * **Production only, and this is not the mistake ADR-050 records.** That one was a build script
 * switching itself off on an unset `NODE_ENV` that nothing in that process validated. This runs
 * inside the NestJS app, where `validateEnv` makes `NODE_ENV` a required enum with no default
 * (ADR-045) — it cannot be absent without the app refusing to boot. `StripeService`'s own boot
 * probe already depends on exactly this, for exactly this reason.
 *
 * Outside production the placeholder is correct and harmless: a development row naming an
 * unpublished document is false too, and matters to nobody. Gating on the environment here is
 * what keeps the test suite from having to bypass the guard on every run — the rubber-stamp
 * decay `CLAUDE.md` names.
 *
 * Takes both inputs as parameters rather than reading either, so every combination is testable
 * without touching a constant or an environment.
 */
export function assertPlatformTermsPublished(nodeEnv: string, currentVersion: string): void {
  if (nodeEnv !== "production") return;
  if (currentVersion !== PLATFORM_TERMS_PLACEHOLDER) return;
  throw new AppException(
    "REGISTRATION_UNAVAILABLE",
    "Registration is not open yet. Our terms of service have not been published, and we will " +
      "not record an agreement to a document that does not exist.",
    503,
  );
}
