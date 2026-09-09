"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent, type JSX } from "react";
import { fetchCurrentAgreements } from "../../../lib/api/agreements";
import { acceptInvitation } from "../../../lib/api/staff";
import { Wordmark } from "../../../components/wordmark";
import { t } from "../../../lib/i18n";

/**
 * Accept an invitation — the screen the invitation email has been linking to since ADR-070, and
 * which did not exist. The mail arrived, the link worked, and it landed on a 404: **that missing
 * page was the single reason the whole email path was useless.**
 *
 * `/invitations/accept?email=…&token=…` — the shape `MembershipInvitationService.acceptUrl` builds.
 * Both values come from the link because the API looks candidates up by email and hash-verifies
 * the token against each (ADR-020), rather than keying a lookup on the secret itself.
 *
 * ── The agreement block, and why it is here rather than in a migration ────────────────────────
 *
 * Accepting an invitation is the **second path that creates a `User`**, and it recorded no
 * `AgreementAcceptance` — registration has since ADR-049, this did not. It could not be repaired
 * afterwards, because a row written later asserts that somebody agreed at a moment when nobody
 * asked them. The gap therefore had to be closed at the moment the question could first be put,
 * and this screen is that moment: before it existed there was nowhere to ask.
 *
 * The block is the register screen's, deliberately identical in shape:
 *   - the Terms get an **unticked** checkbox — the row claims *this person accepted revision X at
 *     time T*, which is only honest if they did something about the terms rather than about
 *     joining a workplace;
 *   - the version is **fetched** from `GET /agreements/current`, never a constant in this bundle,
 *     so what is submitted is what this page actually rendered — which is what gives the server's
 *     `TERMS_VERSION_MISMATCH` its meaning;
 *   - if it cannot be fetched, the screen refuses rather than sending a blank. No version means no
 *     honest record of what was agreed to.
 *
 * ── Two states, decided by the server rather than guessed here ────────────────────────────────
 *
 * Somebody accepting may already have an account. The server takes that branch on its own — it
 * requires a password, a name and the terms **only** when it is the request creating the `User` —
 * so this screen offers all three and the server ignores them when they are not needed. Asking a
 * person who already agreed to agree again would record a second consent for a day nobody asked.
 */
export default function AcceptInvitationPage(): JSX.Element {
  return (
    <Suspense fallback={<Centered>{t("accept.checking")}</Centered>}>
      <AcceptInvitationForm />
    </Suspense>
  );
}

const FIELD_CLASS =
  "h-control w-full rounded-portal border border-rule bg-surface px-3 text-body text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent";

function AcceptInvitationForm(): JSX.Element {
  const params = useSearchParams();
  const email = params.get("email") ?? "";
  const token = params.get("token") ?? "";

  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [termsVersion, setTermsVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await fetchCurrentAgreements();
      if (cancelled) return;
      if (result.ok) setTermsVersion(result.data.platformTerms.version);
      else setError(t("accept.error.termsUnavailable"));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // A link that arrived without its two values cannot be acted on, and the honest thing is to say
  // which link to use rather than to show a form that will always be refused.
  if (email === "" || token === "") {
    return (
      <Centered>
        <div className="max-w-prose space-y-3" data-testid="accept-missing-link">
          <h1 className="text-hero-2 font-semibold">{t("accept.invalid.title")}</h1>
          <p className="text-body text-muted">{t("accept.missingLink.body")}</p>
        </div>
      </Centered>
    );
  }

  if (done) {
    return (
      <Centered>
        <div className="max-w-prose space-y-3" data-testid="accept-done">
          <h1 className="text-hero-2 font-semibold">{t("accept.done.title")}</h1>
          {/* No session is issued here, deliberately: MASTERPLAN's own journey has "creates a
              password" and "logs in" as separate steps, and the existing login route is what
              proves the account actually works. */}
          <p className="text-body text-muted">{t("accept.done.body")}</p>
          <Link href="/login" className="text-body underline" data-testid="accept-sign-in">
            {t("accept.done.signIn")}
          </Link>
        </div>
      </Centered>
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    if (displayName.trim() === "") {
      setError(t("accept.error.nameRequired"));
      return;
    }
    if (password.length < 8) {
      setError(t("accept.error.passwordRequired"));
      return;
    }
    if (!termsAccepted) {
      setError(t("accept.error.termsRequired"));
      return;
    }
    if (termsVersion === null) {
      setError(t("accept.error.termsUnavailable"));
      return;
    }

    setSubmitting(true);
    const result = await acceptInvitation({
      email,
      token,
      password,
      displayName: displayName.trim(),
      acceptedTermsVersion: termsVersion,
    });
    setSubmitting(false);

    if (!result.ok) {
      // Codes first, status second — the same order the register screen uses, and for the same
      // reason: the message text is the one part of the envelope the contract allows to change.
      if (result.error.code === "PASSWORD_BREACHED") setError(t("register.error.breached.explain"));
      else if (result.error.code === "TERMS_VERSION_MISMATCH")
        setError(t("accept.error.termsChanged"));
      else if (result.error.code === "INVITATION_INVALID") setError(t("accept.invalid.body"));
      else if (result.error.code === "NETWORK_UNAVAILABLE") setError(t("accept.error.unreachable"));
      else if (result.error.status === 429) setError(t("accept.error.tooManyAttempts"));
      else setError(t("accept.error.generic"));
      return;
    }

    setDone(true);
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6" data-testid="accept-form">
        <h1>
          <Wordmark />
        </h1>
        <p className="text-body text-muted">{t("accept.explain")}</p>

        <form className="space-y-4" onSubmit={(e) => void onSubmit(e)} noValidate>
          {/* The address is shown and not editable: it is what the token was issued against, and a
              typed-over address would simply fail to match any invitation. */}
          <p className="text-small text-muted" data-testid="accept-email">
            {email}
          </p>

          <label className="block space-y-1">
            <span className="text-small text-muted">{t("accept.displayName")}</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className={FIELD_CLASS}
              data-testid="accept-display-name"
              autoComplete="name"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-small text-muted">{t("accept.password")}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={FIELD_CLASS}
              data-testid="accept-password"
              autoComplete="new-password"
            />
          </label>

          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={termsAccepted}
              onChange={(e) => setTermsAccepted(e.target.checked)}
              className="mt-1"
              data-testid="accept-terms"
            />
            <span className="text-small text-muted">
              {t("register.terms.agree")}{" "}
              <Link href="/terms" className="underline">
                {t("register.terms.link")}
              </Link>
            </span>
          </label>

          {error !== null ? (
            <p className="text-small text-ink" role="alert" data-testid="accept-error">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            className="h-control w-full rounded-portal bg-accent px-4 text-body font-medium text-on-accent"
            disabled={submitting}
            data-testid="accept-submit"
          >
            {submitting ? t("accept.submitting") : t("accept.submit")}
          </button>
        </form>
      </div>
    </main>
  );
}

function Centered({ children }: { children: React.ReactNode }): JSX.Element {
  return <main className="flex min-h-screen items-center justify-center p-6">{children}</main>;
}
