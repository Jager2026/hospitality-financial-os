import type { JSX } from "react";
import { t } from "../lib/i18n";

/**
 * A legal document that has a URL but no text yet.
 *
 * Separate from `Stub` on purpose, even though both say "not built": a screen that is unbuilt is a
 * product gap, while an agreement that is unwritten is a **correctness** problem for records
 * already being written against its version (ADR-049). The wording differs accordingly, and this
 * page is where a reader finds out that an acceptance recorded today would point at nothing.
 *
 * It exists so the links on Register are real rather than dead. A 404 behind "Read the Terms of
 * Service" is worse than an honest page — it reads as a broken site rather than an unfinished one,
 * and tells the reader nothing about what they are being asked to agree to.
 */
export function UnpublishedAgreement({ title }: { title: string }): JSX.Element {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-6">
      <h1 className="text-hero-2 font-bold">{title}</h1>
      <p className="max-w-sm text-center text-small text-muted">{t("agreement.unpublished")}</p>
    </main>
  );
}
