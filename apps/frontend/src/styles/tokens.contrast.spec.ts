import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACCENT_PALETTE,
  CONTRAST_FLOOR,
  DEFAULT_ACCENT_ID,
  ON_ACCENT_DARK,
  ON_ACCENT_LIGHT,
  REJECTED_ACCENTS,
} from "./accent-palette";

/**
 * `docs/DESIGN_SYSTEM.md` Part 2 is written to one standard, the Founder's: **measured, or it
 * does not exist.** A number that lives only in a document decays — someone nudges a hex, the
 * prose still claims the old ratio, and nothing anywhere notices. This file is what stops that:
 * every ratio the document states is re-derived here from `tokens.css` itself, so the document
 * and the code cannot drift apart silently.
 *
 * It is deliberately written to fail against a plausible wrong implementation, per
 * `CLAUDE.md`'s Testing Philosophy — a colour typo, a ramp step swapped for a neighbouring one,
 * one of the two dark blocks updated without the other, or a green accent slipped into the
 * customisation palette each break a specific assertion below.
 */

// ── measurement ────────────────────────────────────────────────────────────────────────────

function relativeLuminance(hex: string): number {
  const h = hex.replace("#", "");
  const channels = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** WCAG 2.1 relative contrast, rounded the same way the document records it. */
function contrast(a: string, b: string): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)];
  return Number((((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) as number).toFixed(2));
}

/** Hue in degrees, used only to enforce the semantic-hue exclusion below. */
function hue(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let deg: number;
  if (max === r) deg = ((g - b) / d) % 6;
  else if (max === g) deg = (b - r) / d + 2;
  else deg = (r - g) / d + 4;
  deg *= 60;
  return deg < 0 ? deg + 360 : deg;
}

// ── read the real stylesheet, not a copy of its values ─────────────────────────────────────

const CSS = readFileSync(join(__dirname, "tokens.css"), "utf8");

// Comments are stripped before any parsing: they contain braces and measured ratios, and a
// comment must never be able to satisfy an assertion about the code.
const STRIPPED = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Declarations of one selector block, merged across every occurrence of that selector.
 * Matches innermost blocks only, which is what makes the `@media`-nested dark block parse
 * correctly — an earlier version split on braces and silently read the `@media` line as the
 * selector, so the two dark blocks appeared to differ when they did not.
 */
function block(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of STRIPPED.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const head = m[1].trim().split("\n").pop()?.trim();
    if (head !== selector) continue;
    for (const decl of m[2].split(";")) {
      const idx = decl.indexOf(":");
      if (idx === -1) continue;
      const k = decl.slice(0, idx).trim();
      // Whitespace is stripped, not trimmed: Prettier wraps a long declaration across lines
      // (`var(\n  --n-400\n)`), which is cosmetic but made two identical values compare
      // unequal. Every value in this file is a single token — a hex, a `var()`, a length —
      // so there is no whitespace here that carries meaning.
      if (k.startsWith("--")) out[k] = decl.slice(idx + 1).replace(/\s+/g, "");
    }
  }
  return out;
}

const root = block(":root");

/** Resolves one level of `var(--x)` against the ramp, which is all these tokens ever use. */
function resolve(value: string | undefined, scope: Record<string, string>): string {
  if (!value) throw new Error("token missing from tokens.css");
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  if (!ref) return value;
  const target = scope[ref[1]] ?? root[ref[1]];
  if (!target) throw new Error(`unresolved ${ref[1]}`);
  return target;
}

function surface(selector: string): { ground: string; text: string; muted: string; rule: string } {
  const b = selector === ":root" ? root : { ...root, ...block(selector) };
  return {
    ground: resolve(b["--ground"], b),
    text: resolve(b["--text"], b),
    muted: resolve(b["--text-muted"], b),
    rule: resolve(b["--rule"], b),
  };
}

// ── the documented numbers, exactly as DESIGN_SYSTEM.md Part 2 states them ──────────────────

const DOCUMENTED = {
  portalLight: { selector: ":root", text: 18.46, muted: 4.92, rule: 1.4 },
  portalDark: { selector: '[data-theme="dark"]', text: 18.46, muted: 5.85, rule: 1.41 },
  terminal: { selector: '[data-surface="terminal"]', text: 19.29, muted: 5.14, rule: 1.14 },
} as const;

describe("design tokens — surfaces", () => {
  for (const [name, spec] of Object.entries(DOCUMENTED)) {
    it(`${name}: text and muted match the ratios DESIGN_SYSTEM.md records, and clear the 4.5 floor`, () => {
      const s = surface(spec.selector);
      expect(contrast(s.text, s.ground)).toBe(spec.text);
      expect(contrast(s.muted, s.ground)).toBe(spec.muted);
      // The floor is the point of the muted step. `#7A756D` looks like unmistakably readable
      // grey and measures 4.38 — it was caught here, by number, not by eye.
      expect(contrast(s.muted, s.ground)).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
    });
  }

  it("rules divide light and dark with equal emphasis — within 0.01 of each other", () => {
    const light = surface(":root");
    const dark = surface('[data-theme="dark"]');
    const lightRule = contrast(light.rule, light.ground);
    const darkRule = contrast(dark.rule, dark.ground);
    expect(lightRule).toBe(DOCUMENTED.portalLight.rule);
    expect(darkRule).toBe(DOCUMENTED.portalDark.rule);
    // A divider wants ~1.4:1 — enough to separate, not enough to catch the eye. The two
    // surfaces landing together is a large part of why they read as one product.
    // Compared in whole hundredths: `1.41 - 1.40` is 0.010000000000000009 in binary floating
    // point, so a direct `<= 0.01` fails on a pair that is exactly one hundredth apart.
    expect(Math.round(Math.abs(lightRule - darkRule) * 100)).toBeLessThanOrEqual(1);
  });

  it("the two dark blocks agree — the media query and the explicit data-theme override", () => {
    // These are maintained by hand as two blocks, so they are exactly the pair that drifts:
    // someone edits one and the toggle silently stops matching the OS preference.
    const media = block(':root:not([data-theme="light"])');
    const explicit = block('[data-theme="dark"]');
    expect(Object.keys(explicit).length).toBeGreaterThan(0);
    for (const [token, value] of Object.entries(explicit)) {
      expect(media[token], `${token} differs between the dark blocks`).toBe(value);
    }
  });

  it("light can be pinned on a subtree, not only inherited from :root", () => {
    // Found by rendering the specimen on a dark machine: the card meant to demonstrate the
    // light default rendered dark, because light lived only on `:root` and the media query
    // matched it. `[data-theme="light"]` is attribute-scoped for the same reason the terminal
    // is — "pin a surface" has to mean one thing everywhere, or each surface grows its own
    // rules and they drift.
    const light = surface('[data-theme="light"]');
    const rootLight = surface(":root");
    expect(light.ground).toBe(rootLight.ground);
    expect(light.text).toBe(rootLight.text);
    expect(light.muted).toBe(rootLight.muted);
  });

  it("the terminal cannot be darkened by a guest's own device preference", () => {
    // Load-bearing, not incidental: the terminal's surface is chosen on legibility — it may be
    // read in direct sunlight — so `prefers-color-scheme` must not repaint it. Custom
    // properties on a descendant beat inherited ones regardless of ancestor specificity, which
    // only holds while the terminal is scoped to a wrapper rather than to :root.
    const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(stripped).toContain('[data-surface="terminal"] {');
    expect(stripped).not.toMatch(/:root\[data-surface="terminal"\]/);
    expect(surface('[data-surface="terminal"]').ground).toBe(root["--n-0"]);
  });
});

describe("design tokens — accent", () => {
  it("every palette value measures what it claims, and clears the floor on both surfaces", () => {
    for (const a of ACCENT_PALETTE) {
      expect(contrast(a.light, ON_ACCENT_LIGHT), `${a.id} light`).toBe(a.lightOnAccent);
      expect(contrast(a.dark, ON_ACCENT_DARK), `${a.id} dark`).toBe(a.darkOnAccent);
      expect(a.lightOnAccent).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
      expect(a.darkOnAccent).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
    }
  });

  it("no palette value is green or red — the exclusion is structural, not stylistic", () => {
    // A brand accent that collides with --success or --error makes "press this" and "this
    // worked" indistinguishable on the terminal, where a guest gets ten seconds. This is why
    // the customisation feature offers a fixed list and never a colour picker: a free hex
    // field cannot enforce a hue exclusion. Here that constraint is executable.
    for (const a of ACCENT_PALETTE) {
      for (const value of [a.light, a.dark]) {
        const h = hue(value);
        const isGreen = h >= 85 && h <= 170;
        expect(isGreen, `${a.id} ${value} sits in the success-green range`).toBe(false);
        const isRed = h >= 345 || h <= 20;
        expect(isRed, `${a.id} ${value} sits in the error-red range`).toBe(false);
      }
    }
  });

  it("the CSS default is the amber the palette names, not a literal that drifted from it", () => {
    const amber = ACCENT_PALETTE.find((a) => a.id === DEFAULT_ACCENT_ID);
    expect(amber).toBeDefined();
    expect(root["--accent-light"]?.toLowerCase()).toBe(amber?.light.toLowerCase());
    expect(root["--accent-dark"]?.toLowerCase()).toBe(amber?.dark.toLowerCase());
  });

  it("the default is the weakest value in its own set — recorded, not hidden", () => {
    // Not a defect. Amber is chosen for what it means in this industry rather than for its
    // ratio, and it clears the floor with real headroom. The assertion exists so the fact
    // stays true and visible: if a later edit made some alternate weaker than the default,
    // that would mean the palette changed shape and the record should be re-read.
    const amber = ACCENT_PALETTE.find((a) => a.id === DEFAULT_ACCENT_ID)!;
    const alternates = ACCENT_PALETTE.filter((a) => a.id !== DEFAULT_ACCENT_ID);
    for (const alt of alternates) {
      expect(alt.lightOnAccent).toBeGreaterThan(amber.lightOnAccent);
    }
  });

  it("the rejected amber still fails, which is why it is kept", () => {
    // #B5701F looks like a perfectly good amber. It measured 3.87 against the pay button's own
    // text — under the floor, on the one screen where a stranger gets ten seconds. Keeping the
    // measurement executable is what turns "let's brighten it up" from a taste debate back
    // into a contrast failure.
    for (const r of REJECTED_ACCENTS) {
      expect(contrast(r.hex, ON_ACCENT_LIGHT)).toBe(r.measuredOnAccentLight);
      expect(contrast(r.hex, ON_ACCENT_LIGHT)).toBeLessThan(CONTRAST_FLOOR);
    }
  });
});

describe("design tokens — semantic state", () => {
  it("success and error clear the floor on both surfaces", () => {
    const light = surface(":root");
    const dark = surface('[data-theme="dark"]');
    const pairs: [string, string][] = [
      [root["--success-light"], light.ground],
      [root["--error-light"], light.ground],
      [root["--success-dark"], dark.ground],
      [root["--error-dark"], dark.ground],
    ];
    for (const [colour, ground] of pairs) {
      expect(contrast(colour, ground)).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
    }
  });

  it("there is no warning colour, and that is the decision", () => {
    // DESIGN_SYSTEM.md: the two places one gets reached for are the two places the document
    // forbids alarming — the platform-fee caption and an empty dashboard. A system that owns
    // an amber warning token will use it in exactly those two places within a month. Not
    // having the token is cheaper than the discipline of not using it, so its absence is
    // asserted rather than merely intended.
    const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(stripped).not.toMatch(/--warning/);
    expect(stripped).not.toMatch(/--caution/);
  });
});

describe("design tokens — the Hierarchy Law, as arithmetic", () => {
  const px = (token: string): number => Number(root[token].replace("px", ""));

  it("the hero is at least 3x body", () => {
    expect(px("--text-hero") / px("--text-body")).toBeGreaterThanOrEqual(3);
  });

  it("no other role exceeds 0.625x the hero, so a second rank-1 element is impossible", () => {
    // This is what makes the Hierarchy Law enforceable rather than advisory: "make it bigger"
    // stops being a specification and a review can fail on a number instead of an opinion.
    //
    // The constant is 0.625, not the 0.62 DESIGN_SYSTEM.md first wrote. The rule was derived
    // from the intended pair (48 -> 30) and then rounded DOWN in prose, which made the
    // document forbid its own example. Caught by this test on its first run; the document was
    // corrected to match the arithmetic rather than the arithmetic bent to match the prose.
    const hero = px("--text-hero");
    for (const token of ["--text-hero-2", "--text-title", "--text-body", "--text-small"]) {
      expect(px(token) / hero, `${token} competes with the hero`).toBeLessThanOrEqual(0.625);
    }
  });

  it("the terminal's own targets clear UX_MAP's 44px floor with room to spare", () => {
    expect(px("--control-terminal")).toBeGreaterThanOrEqual(px("--target-min"));
    expect(px("--control-terminal")).toBeGreaterThan(px("--control-portal"));
  });
});
