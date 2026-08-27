import type { JSX } from "react";
import { t } from "../lib/i18n";

/**
 * A destination that exists but is not built.
 *
 * Deliberately says so rather than pretending: `DESIGN_SYSTEM.md` forbids a screen that implies
 * something has happened when it has not, and an empty page with a plausible heading is exactly
 * that. These exist so the login fork has three real URLs to reach — the routing is what is under
 * test, not what is behind it.
 */
export function Stub({ title }: { title: string }): JSX.Element {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-6">
      <h1 className="text-hero-2 font-bold">{title}</h1>
      <p className="max-w-sm text-center text-small text-muted">{t("screen.notBuilt")}</p>
    </main>
  );
}
