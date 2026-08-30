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
