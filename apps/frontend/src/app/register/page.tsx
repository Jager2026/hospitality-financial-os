"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent, type JSX } from "react";
import { fetchCurrentAgreements } from "../../lib/api/agreements";
import { apiPost } from "../../lib/api/client";
import { destinationAfterLogin } from "../../lib/auth/destination";
import { saveSession, type StoredSession } from "../../lib/auth/session";
import { Wordmark } from "../../components/wordmark";
import { t } from "../../lib/i18n";

/**
 * Register — `UX_MAP.md`, "Getting In". Turns a stranger into an account and nothing else: no
 * Restaurant, no Organization, zero Memberships, which `DATABASE.md` explicitly allows and the
 * next screen resolves.
 *
 * Built the same way as Log In: every colour, size and spacing is a token, every string is a
 * dictionary lookup, and the wordmark is the heading rather than sitting above one.
 *
 * The part that is new here is the agreement block (ADR-049), and its shape follows from the
 * lawful basis rather than from taste:
 *
 *   - The **Terms** get an unticked checkbox, never pre-ticked and never "by continuing you
 *     agree". The row this writes claims *this person accepted revision X at time T*, and that is
 *     only honest if they did something about the terms rather than about creating an account.
 *   - The **Privacy Policy** gets a link and a notice and no checkbox, because our basis for
 *     processing is the contract with the person, not consent. A checkbox would tell them they
 *     hold a withdrawal right they do not hold.
 *   - The version is **fetched**, and submitted back. If it cannot be fetched, this screen refuses
 *     to register rather than sending a blank: no version means no honest record of what was
 *     agreed to. Failing closed is the whole point of the field.
 */

/** Two shapes, not one string, because the breached-password rejection is four lines of prose and
 * everything else is one. Collapsing them would mean building that block conditionally out of a
 * string, which is how the third line — the one that says this is not about *your* account —
 * quietly gets dropped. */
type RegisterError = { kind: "message"; text: string } | { kind: "breached" } | null;

const FIELD_CLASS =
  "h-control rounded-portal border border-rule bg-surface px-3 text-body text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent";

export default function RegisterPage(): JSX.Element {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [termsVersion, setTermsVersion] = useState<string | null>(null);
  const [error, setError] = useState<RegisterError>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await fetchCurrentAgreements();
      if (cancelled) return;
      if (result.ok) setTermsVersion(result.data.platformTerms.version);
      else setError({ kind: "message", text: t("register.error.termsUnavailable") });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    // Checked here rather than by disabling the button. A disabled control states that something
    // is wrong without saying what, and this is the one field on the screen whose purpose a person
    // is entitled to have explained (DESIGN_SYSTEM.md: clarity comes from explanation, never from
    // suppression).
    if (!termsAccepted) {
      setError({ kind: "message", text: t("register.error.termsRequired") });
      return;
    }
    if (termsVersion === null) {
      setError({ kind: "message", text: t("register.error.termsUnavailable") });
      return;
    }

    setSubmitting(true);
    const result = await apiPost<StoredSession>("/auth/register", {
      email,
      password,
      displayName,
      acceptedTermsVersion: termsVersion,
    });

    if (!result.ok) {
      // Codes first, status second. The two 409s this endpoint can return — a stale terms version
      // and an email already in use — are told apart by code alone, and deliberately so: the
      // message text is the one part of the envelope the contract says may be translated.
      if (result.error.code === "PASSWORD_BREACHED") setError({ kind: "breached" });
      else if (result.error.code === "TERMS_VERSION_MISMATCH")
        setError({ kind: "message", text: t("register.error.termsChanged") });
      else if (result.error.code === "NETWORK_UNAVAILABLE")
        setError({ kind: "message", text: t("register.error.unreachable") });
      else if (result.error.status === 429)
        setError({ kind: "message", text: t("register.error.tooManyAttempts") });
      else if (result.error.code === "REGISTRATION_UNAVAILABLE")
        setError({ kind: "message", text: t("register.error.unavailable") });
      else if (result.error.status === 409)
        setError({ kind: "message", text: t("register.error.rejected") });
      else setError({ kind: "message", text: t("register.error.invalid") });
      setSubmitting(false);
      return;
    }

    // Straight into the signed-in state — UX_MAP.md, "Primary action: Create account". There is no
    // email confirmation step, and the fork that decides where a person lands is the same pure
    // function login uses, never a second copy of the branch.
    saveSession(result.data);
    router.push(destinationAfterLogin(result.data.memberships));
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-8">
        <h1>
          <Wordmark size="entry" />
        </h1>

        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <label className="flex flex-col gap-2">
            <span className="text-label uppercase text-muted">{t("register.email")}</span>
            <input
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={FIELD_CLASS}
            />
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-label uppercase text-muted">{t("register.displayName")}</span>
            <input
              name="displayName"
              type="text"
              autoComplete="name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className={FIELD_CLASS}
            />
            {/* Required, not optional (ADR-033): this is what colleagues see when choosing who
                served a table, so the screen says what it is for rather than just demanding it. */}
            <span className="text-small text-muted">{t("register.displayNameHint")}</span>
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-label uppercase text-muted">{t("register.password")}</span>
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={FIELD_CLASS}
            />
            <span className="text-small text-muted">{t("register.passwordHint")}</span>
          </label>

          <div className="flex flex-col gap-2">
            {/* `accent-accent` reads oddly and is the right token: Tailwind's accent-color utility
                draws from the same colour scale as `bg-accent`, so the checkbox follows a
                restaurant's own accent without a literal appearing here. Never `defaultChecked` —
                a pre-ticked box is not an act. */}
            <label className="flex items-start gap-3">
              <input
                name="acceptTerms"
                type="checkbox"
                checked={termsAccepted}
                onChange={(e) => setTermsAccepted(e.target.checked)}
                className="mt-1 h-4 w-4 shrink-0 accent-accent"
              />
              <span className="text-small text-ink">{t("register.terms.agree")}</span>
            </label>

            <div className="flex flex-col gap-1 pl-7">
              <Link href="/terms" className="text-small text-accent underline">
                {t("register.terms.link")}
              </Link>
              <Link href="/privacy" className="text-small text-accent underline">
                {t("register.privacy.link")}
              </Link>
            </div>

            <p className="text-small text-muted">{t("register.privacy.notice")}</p>
          </div>

          {/* `role="alert"` rather than a styled div: a screen reader must hear the rejection, and
              a test should assert the thing a person actually perceives. */}
          {error?.kind === "message" && (
            <p role="alert" className="text-small text-error">
              {error.text}
            </p>
          )}
          {error?.kind === "breached" && (
            <div role="alert" className="flex flex-col gap-2 text-small text-error">
              <strong>{t("register.error.breached.title")}</strong>
              <span>{t("register.error.breached.explain")}</span>
              <span>{t("register.error.breached.notYou")}</span>
              <span>{t("register.error.breached.action")}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="mt-2 h-control rounded-portal bg-accent px-4 text-body font-semibold text-on-accent disabled:opacity-60"
          >
            {submitting ? t("register.submitting") : t("register.submit")}
          </button>
        </form>

        <p className="text-small text-muted">
          {t("register.haveAccount")}{" "}
          <Link href="/login" className="text-accent underline">
            {t("register.logIn")}
          </Link>
        </p>
      </div>
    </main>
  );
}
