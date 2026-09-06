import type { JSX } from "react";
import { t } from "../../lib/i18n";

/** Shown while a Portal screen's own code is still arriving. Deliberately words rather than a
 * spinner: "loading the current shift" says what is being waited for, and a spinner says only
 * that something is. */
export default function Loading(): JSX.Element {
  return <p className="text-muted">{t("dashboard.loading")}</p>;
}
