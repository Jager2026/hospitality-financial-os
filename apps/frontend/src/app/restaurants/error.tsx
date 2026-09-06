"use client";

import type { JSX } from "react";
import { t } from "../../lib/i18n";

/**
 * The boundary for anything that throws inside the Portal.
 *
 * **It shows no figure, and that is the design rather than a limitation.** The alternative — a
 * screen that keeps its last numbers on display while something underneath has failed — is a
 * number nobody can stand behind, on a screen whose whole purpose is numbers somebody can.
 *
 * `error.digest` is deliberately not shown. It identifies the server-side log line, not anything
 * the reader can act on, and a hex string next to an apology reads as a system talking to itself.
 */
export default function PortalError({ reset }: { error: Error; reset: () => void }): JSX.Element {
  return (
    <section className="max-w-prose space-y-3" data-testid="portal-error">
      <h1 className="text-hero-2 font-semibold">{t("error.title")}</h1>
      <p className="text-muted">{t("error.explain")}</p>
      <button
        type="button"
        onClick={reset}
        className="rounded-portal border border-rule px-4 py-2 text-small"
      >
        {t("error.retry")}
      </button>
    </section>
  );
}
