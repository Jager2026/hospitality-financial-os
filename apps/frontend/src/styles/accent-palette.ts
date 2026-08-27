/**
 * The verified accent palette — `docs/DESIGN_SYSTEM.md` v1.0.0, Part 2.
 *
 * This exists as data, not documentation, for one reason the Founder named precisely: the
 * restaurant-branding candidate (`MASTERPLAN.md`) must offer a **fixed list, never a colour
 * picker**. A free hex field cannot enforce a hue exclusion, so the constraint has to live in
 * which values exist rather than in what a UI hopes people will avoid.
 *
 * Two exclusions are structural, not stylistic:
 *   - **No green.** A brand accent and the semantic "succeeded" cannot be the same colour, or a
 *     guest on the terminal cannot tell *press this* from *this worked*.
 *   - **No red.** Same argument against `--error`.
 *
 * Every value carries the ratio it was measured at. A value without a measurement cannot enter
 * this list — `tokens.contrast.spec.ts` re-measures all of them and fails on drift.
 */

export interface AccentValue {
  /** Stable id — what a Restaurant row would store, never the hex itself. */
  readonly id: string;
  readonly label: string;
  /** Value on a light surface (Portal default, and the terminal). */
  readonly light: string;
  /** Value on the dark Portal surface. */
  readonly dark: string;
  /** Measured: `--on-accent` text on the solid light value. Floor is 4.5. */
  readonly lightOnAccent: number;
  /** Measured: `--on-accent` text on the solid dark value. Floor is 4.5. */
  readonly darkOnAccent: number;
}

/** Text colours the ratios above were measured against. */
export const ON_ACCENT_LIGHT = "#FFFCF7";
export const ON_ACCENT_DARK = "#14120F";

/** WCAG 2.1 AA for normal text. The floor, not the target. */
export const CONTRAST_FLOOR = 4.5;

export const ACCENT_PALETTE: readonly AccentValue[] = [
  // Default. Chosen for what amber means in this industry rather than for its ratio — and it
  // is, plainly, the weakest value in its own set. Every alternate below measures 7.79 or
  // better. That is the price of the hue, and it is recorded so nobody later mistakes "it
  // passed" for "it was strongest".
  {
    id: "amber",
    label: "Amber",
    light: "#9A5D14",
    dark: "#E0A050",
    lightOnAccent: 5.19,
    darkOnAccent: 8.29,
  },
  {
    id: "navy",
    label: "Navy",
    light: "#1F4E79",
    dark: "#7FB2DC",
    lightOnAccent: 8.46,
    darkOnAccent: 8.28,
  },
  {
    id: "violet",
    label: "Violet",
    light: "#55408C",
    dark: "#A896DC",
    lightOnAccent: 8.21,
    darkOnAccent: 7.18,
  },
  {
    id: "plum",
    label: "Plum",
    light: "#7A2E52",
    dark: "#D48CAC",
    lightOnAccent: 8.77,
    darkOnAccent: 7.25,
  },
  {
    id: "slate",
    label: "Slate",
    light: "#3D5460",
    dark: "#96B2BF",
    lightOnAccent: 7.79,
    darkOnAccent: 8.38,
  },
];

export const DEFAULT_ACCENT_ID = "amber";

/**
 * Kept as evidence rather than deleted. The amber reached for first measured 3.87:1 against the
 * pay button's own text — under the floor, on the one screen where a stranger gets ten seconds
 * and no second attempt. A light amber is structurally unavailable to us: this hue only
 * qualifies pushed toward brown. Any future "let's brighten it up" re-opens a measured contrast
 * failure, not a taste debate, and `tokens.contrast.spec.ts` asserts this value still fails.
 */
export const REJECTED_ACCENTS = [{ hex: "#B5701F", measuredOnAccentLight: 3.87 }] as const;
