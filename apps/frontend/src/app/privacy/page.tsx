import type { JSX } from "react";
import { t } from "../../lib/i18n";
import { UnpublishedAgreement } from "../_unpublished-agreement";

/** Privacy Policy — linked from Register as a notice, never as something to agree to (ADR-049).
 * Not written yet, and the page says exactly that. */
export default function PrivacyPage(): JSX.Element {
  return <UnpublishedAgreement title={t("privacy.title")} />;
}
