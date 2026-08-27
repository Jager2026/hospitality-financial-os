import type { JSX } from "react";

/**
 * The product's name on screen — `DESIGN_SYSTEM.md`, Product Identity On Screen.
 *
 * Typographic rather than a logo: there is no logo, and inventing one is not a decision to make
 * while building a form. One face, because IBM Plex Sans is the only face this system has.
 *
 * **Never the accent colour.** It renders in `--text`, following from "accent colour never carries
 * importance" — accent marks actions and status, and a wordmark is neither. The useful
 * consequence: a restaurant may own the accent (MASTERPLAN.md's branding candidate) and therefore
 * can never recolour our name. They brand the surface they paid for; they do not rebrand us.
 *
 * Not a dictionary entry: a product name is not translated (ADR-040).
 */
export const PRODUCT_NAME = "PlainTabs";

type WordmarkSize = "entry" | "chrome" | "attribution";

/**
 * `entry`       — Log In, Register, Accept Invitation. Rank 1: the only confirmation a person has
 *                 that they are in the right product before they hand over a password.
 * `chrome`      — inside the Portal. Orientation, not confirmation.
 * `attribution` — the terminal's completion state only, never the payment step. A guest needs to
 *                 trust the restaurant, not us; our name is noise before the money moves and an
 *                 answer to a real question after it.
 */
const SIZE: Record<WordmarkSize, string> = {
  entry: "text-hero-2 font-bold tracking-[-0.02em]",
  chrome: "text-label font-semibold uppercase tracking-[0.12em]",
  attribution: "text-micro font-medium",
};

export function Wordmark({ size = "entry" }: { size?: WordmarkSize }): JSX.Element {
  return (
    <span className={`${SIZE[size]} text-ink`} data-wordmark>
      {PRODUCT_NAME}
    </span>
  );
}
