import Link from "next/link";
import type { JSX } from "react";
import { t } from "../lib/i18n";

/** 404. It names what happened and offers the one route that always exists for a signed-in
 * person, rather than a dead end. */
export default function NotFound(): JSX.Element {
  return (
    <main className="mx-auto max-w-prose space-y-3 p-8">
      <h1 className="text-hero-2 font-semibold">{t("notFound.title")}</h1>
      <p className="text-muted">{t("notFound.explain")}</p>
      <Link href="/restaurants" className="text-small underline">
        {t("notFound.home")}
      </Link>
    </main>
  );
}
