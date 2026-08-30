import type { JSX } from "react";
import { t } from "../../lib/i18n";
import { UnpublishedAgreement } from "../_unpublished-agreement";

/** Terms of Service — the document Register links to. Not written yet, and the page says exactly
 * that (ADR-049; IMPLEMENTATION_PLAN.md, Blocking Gate Before The First Pilot Restaurant). */
export default function TermsPage(): JSX.Element {
  return <UnpublishedAgreement title={t("terms.title")} />;
}
