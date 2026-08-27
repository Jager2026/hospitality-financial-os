"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type JSX } from "react";
import { apiPost } from "../../lib/api/client";
import { destinationAfterLogin } from "../../lib/auth/destination";
import { saveSession, type StoredSession } from "../../lib/auth/session";
import { Wordmark } from "../../components/wordmark";
import { t } from "../../lib/i18n";

/**
 * Log In — `UX_MAP.md`, "Getting In".
 *
 * Built entirely from the token layer: every colour, size, radius and spacing below is a token
 * (`styles/tokens.css`) reached through Tailwind. No literal values were added while building this
 * screen — if something had been missing, that would have been a finding about the design system,
 * not a licence to write a hex here.
 *
 * Two pieces of the behaviour live outside this file on purpose. `destinationAfterLogin` is the
 * three-way fork the whole Portal inherits, so it is a pure function with its own tests rather
 * than a branch inside a submit handler. `apiPost` unwraps the envelope so no screen has to know
 * the response shape.
 */
export default function LoginPage(): JSX.Element {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const result = await apiPost<StoredSession>("/auth/login", { email, password });

    if (!result.ok) {
      // Three genuinely different failures, worded as three different things. Collapsing them into
      // one message is how a rate-limited person ends up changing a password that was correct
      // (DESIGN_SYSTEM.md: reassurance and clarity come from explanation, never from suppression).
      if (result.error.status === 429) setError(t("login.error.tooManyAttempts"));
      else if (result.error.code === "NETWORK_UNAVAILABLE") setError(t("login.error.unreachable"));
      else setError(t("login.error.invalid"));
      setSubmitting(false);
      return;
    }

    saveSession(result.data);
    router.push(destinationAfterLogin(result.data.memberships));
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-8">
        {/* The wordmark IS the heading — DESIGN_SYSTEM.md, Product Identity On Screen. A separate
            "Log in" above a form with an email field, a password field and a button labelled
            "Log in" tells nobody anything; the name is the thing this screen exists to confirm,
            because it is the only screen a person sees before they know where they are. */}
        <h1>
          <Wordmark size="entry" />
        </h1>

        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <label className="flex flex-col gap-2">
            <span className="text-label uppercase text-muted">{t("login.email")}</span>
            <input
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-control rounded-portal border border-rule bg-surface px-3 text-body text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent"
            />
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-label uppercase text-muted">{t("login.password")}</span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-control rounded-portal border border-rule bg-surface px-3 text-body text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent"
            />
          </label>

          {/* `role="alert"` rather than a styled div: a screen reader must hear the rejection, and
              a test should assert the thing a person actually perceives. */}
          {error !== null && (
            <p role="alert" className="text-small text-error">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="mt-2 h-control rounded-portal bg-accent px-4 text-body font-semibold text-on-accent disabled:opacity-60"
          >
            {submitting ? t("login.submitting") : t("login.submit")}
          </button>
        </form>
      </div>
    </main>
  );
}
