import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACCENT_PALETTE,
  CONTRAST_FLOOR,
  ON_ACCENT_DARK,
  ON_ACCENT_LIGHT,
  REJECTED_ACCENTS,
} from "./accent-palette";

/**
 * `docs/DESIGN_SYSTEM.md` Part 2 is written to one standard, the Founder's: **measured, or it
 * does not exist.** A number that lives only in a document decays — someone nudges a hex, the
 * prose still claims the old ratio, and nothing anywhere notices. This file is what stops that:
 * every ratio the document states is re-derived here from `tokens.css` itself.
 *
 * ── THE FLOOR IS MEASURED FROM THE DEEPEST SURFACE (ADR-072) ────────────────────────────────
 * Every text colour is checked against **every** surface it can land on, which means the
 * binding measurement is against the deepest one. Checking only the ground would certify a
 * value that fails on the very card it is most likely to be used in — the exact hole this
 * rewrite closes, and the second falsification below exists to prove the check has teeth.
 *
 * Written to fail against a plausible wrong implementation, per `CLAUDE.md`'s Testing
 * Philosophy. Two failures are named explicitly because they were specified as the acceptance
 * condition for this change, and both are verified by execution rather than by reading:
 *   1. light text on the accent fill must break a test;
 *   2. a text value that passes on the ground and fails on the deepest surface must break one.
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

/** Declarations of one selector block, merged across every occurrence of that selector. */
function block(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of STRIPPED.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const head = m[1].trim().split("\n").pop()?.trim();
    if (head !== selector) continue;
    for (const decl of m[2].split(";")) {
      const idx = decl.indexOf(":");
      if (idx === -1) continue;
      const k = decl.slice(0, idx).trim();
      // Whitespace is stripped, not trimmed: Prettier wraps a long declaration across lines,
      // which is cosmetic but made two identical values compare unequal.
      if (k.startsWith("--")) out[k] = decl.slice(idx + 1).replace(/\s+/g, "");
    }
  }
  return out;
}

const root = block(":root");

/** Resolves one level of `var(--x)`, which is all these tokens ever use. */
function resolve(value: string | undefined, scope: Record<string, string>): string {
  if (!value) throw new Error("token missing from tokens.css");
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  if (!ref) return value;
  const target = scope[ref[1]] ?? root[ref[1]];
  if (!target) throw new Error(`unresolved ${ref[1]}`);
  return target;
}

interface Surface {
  ground: string;
  surfaces: string[];
  text: string;
  muted: string;
  faint: string;
  rule: string;
}

function surface(selector: string): Surface {
  const b = selector === ":root" ? root : { ...root, ...block(selector) };
  const r = (k: string): string => resolve(b[k], b);
  return {
    ground: r("--ground"),
    // Every surface a text colour can land on, deepest included. The floor is measured against
    // all of them, so the binding one is whichever is hardest to read against.
    surfaces: [r("--ground"), r("--surface"), r("--surface-2"), r("--surface-3")],
    text: r("--text"),
    muted: r("--text-muted"),
    faint: r("--text-faint"),
    rule: r("--rule"),
  };
}

const PORTAL = ":root";
const TERMINAL = '[data-surface="terminal"]';

// ── the documented numbers, exactly as DESIGN_SYSTEM.md Part 2 states them ──────────────────

const DOCUMENTED_PORTAL = {
  text: { onGround: 15.34, onDeepest: 11.21 },
  muted: { onGround: 9.33, onDeepest: 6.82 },
  faint: { onGround: 6.53, onDeepest: 4.77 },
  rule: 1.63,
} as const;

const ACCENT = "#ffe500";
const INK = "#161615";

describe("design tokens — the Portal is dark, and there is no light Portal", () => {
  it("has exactly one Portal appearance: no theme toggle, no colour-scheme branch", () => {
    // Those mechanisms carried a second Portal appearance. There is no second appearance, and a
    // toggle that switches between one thing and itself is a mechanism with nothing behind it.
    expect(STRIPPED).not.toMatch(/\[data-theme="light"\]/);
    expect(STRIPPED).not.toMatch(/\[data-theme="dark"\]/);
    expect(STRIPPED).not.toMatch(/prefers-color-scheme/);
    // The abolished amber must be gone as a value, not merely unreferenced.
    expect(STRIPPED.toLowerCase()).not.toContain("#9a5d14");
    expect(STRIPPED.toLowerCase()).not.toContain("#e0a050");
  });

  it("the surface ladder actually deepens — `--surface-3` is the deepest, not just the last named", () => {
    // Load-bearing for everything below: the floor is described as "measured from the deepest
    // surface", and that sentence is only true while the ladder is ordered. Reordering the
    // values would leave every ratio assertion passing while measuring the wrong pair.
    const p = surface(PORTAL);
    const lums = p.surfaces.map(relativeLuminance);
    for (let i = 1; i < lums.length; i++) {
      expect(lums[i], `surface ${i} is not lighter than surface ${i - 1}`).toBeGreaterThan(
        lums[i - 1],
      );
    }
  });
});

describe("design tokens — text clears the floor on EVERY surface, not just the ground", () => {
  it("the Portal's three text levels measure what DESIGN_SYSTEM.md records", () => {
    const p = surface(PORTAL);
    const deepest = p.surfaces[p.surfaces.length - 1];
    expect(contrast(p.text, p.ground)).toBe(DOCUMENTED_PORTAL.text.onGround);
    expect(contrast(p.text, deepest)).toBe(DOCUMENTED_PORTAL.text.onDeepest);
    expect(contrast(p.muted, p.ground)).toBe(DOCUMENTED_PORTAL.muted.onGround);
    expect(contrast(p.muted, deepest)).toBe(DOCUMENTED_PORTAL.muted.onDeepest);
    expect(contrast(p.faint, p.ground)).toBe(DOCUMENTED_PORTAL.faint.onGround);
    expect(contrast(p.faint, deepest)).toBe(DOCUMENTED_PORTAL.faint.onDeepest);
  });

  // THE SECOND FALSIFICATION, and the reason this loops over surfaces instead of checking the
  // ground: a value that passes on `#161615` and fails on `#30302D` must break a test. It does —
  // verified by substituting one and watching this assertion fail, not by reading it.
  for (const [name, selector] of [
    ["portal", PORTAL],
    ["terminal", TERMINAL],
  ] as const) {
    it(`${name}: every text level clears ${CONTRAST_FLOOR} against every surface it can land on`, () => {
      const s = surface(selector);
      for (const [level, colour] of [
        ["text", s.text],
        ["muted", s.muted],
        ["faint", s.faint],
      ] as const) {
        for (const bg of s.surfaces) {
          expect(contrast(colour, bg), `${name} ${level} on ${bg}`).toBeGreaterThanOrEqual(
            CONTRAST_FLOOR,
          );
        }
      }
    });
  }

  it("the rule divides without catching the eye", () => {
    expect(contrast(surface(PORTAL).rule, surface(PORTAL).ground)).toBe(DOCUMENTED_PORTAL.rule);
  });
});

describe("design tokens — the accent, and the one ink that may sit on it", () => {
  it("is the single yellow, on every surface — one accent, never a hardcoded colour", () => {
    expect(root["--accent"]?.toLowerCase()).toBe(ACCENT);
    // The terminal does not get its own accent: there is one, and it is this one.
    const terminal = { ...root, ...block(TERMINAL) };
    expect(resolve(terminal["--accent"], terminal).toLowerCase()).toBe(ACCENT);
  });

  it("measures 14.19 on the Portal ground and 10.38 on the deepest surface", () => {
    const p = surface(PORTAL);
    expect(contrast(ACCENT, p.ground)).toBe(14.19);
    expect(contrast(ACCENT, p.surfaces[p.surfaces.length - 1])).toBe(10.38);
  });

  // THE FIRST FALSIFICATION. Asserted by RATIO rather than by equality on purpose: an equality
  // check only catches the one wrong value someone happens to think of, while the ratio catches
  // every wrong value there is. `#EFECE4` on `#FFE500` measures 1.08 — not "low contrast",
  // invisible — and setting `--on-accent` to it fails this line.
  it("text on an accent fill clears the floor, which only the ink does", () => {
    const onAccent = resolve(root["--on-accent"], root);
    expect(contrast(onAccent, ACCENT)).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
    expect(onAccent.toLowerCase()).toBe(INK);
  });

  it("the light text token on the accent fill is recorded as unusable, not merely unused", () => {
    // The number is what makes the rule survive a redesign: someone will propose light text on
    // the yellow because it looks calmer, and 1.08 ends that conversation without an argument.
    const p = surface(PORTAL);
    expect(contrast(p.text, ACCENT)).toBe(1.08);
    expect(contrast(p.text, ACCENT)).toBeLessThan(CONTRAST_FLOOR);
  });
});

describe("design tokens — there is no fourth text level, and there will not be", () => {
  it("exactly three text colours exist, in the ladder and in the semantic layer", () => {
    // `--text-hero` and friends share the prefix but are lengths, so the filter is on the VALUE
    // being a colour rather than on the name. A fourth level would have to be a hex under a
    // `--text-*` name, and that is precisely what this refuses.
    const colours = Object.entries(root)
      .filter(([k, v]) => k.startsWith("--text") && /^#[0-9a-f]{6}$/i.test(resolve(v, root)))
      .map(([k]) => k)
      .sort();
    expect(colours).toEqual(["--text", "--text-faint", "--text-muted"]);

    const ladder = Object.keys(root)
      .filter((k) => k.startsWith("--p-text"))
      .sort();
    expect(ladder).toEqual(["--p-text-faint", "--p-text-muted", "--p-text"].sort());
  });

  it("there is no room for one: the faintest passing value sits 0.27 above the floor", () => {
    // This is the whole argument, made executable rather than asserted in prose. A fourth level
    // would have to fit between `--text-faint` (4.77 on the deepest surface) and the floor
    // itself (4.5). Anything in that band differs from `--text-faint` by less than a third of a
    // ratio point — one token with a typo, not two roles.
    //
    // It is also a live guard rather than a decoration: if the deepest surface were ever
    // lightened, the headroom would grow, this assertion would fail, and the decision would have
    // to be re-read instead of quietly reversed.
    const p = surface(PORTAL);
    const headroom = contrast(p.faint, p.surfaces[p.surfaces.length - 1]) - CONTRAST_FLOOR;
    expect(Number(headroom.toFixed(2))).toBe(0.27);
    expect(headroom).toBeLessThan(0.5);
  });
});

describe("design tokens — semantic state", () => {
  it("success and error clear the floor on every Portal surface", () => {
    const p = surface(PORTAL);
    for (const token of ["--success", "--error"]) {
      const colour = resolve(root[token], root);
      for (const bg of p.surfaces) {
        expect(contrast(colour, bg), `${token} on ${bg}`).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
      }
    }
  });

  it("there is no warning colour, and that rule outlives the palette", () => {
    // The palette changed completely; this did not. The two places a warning colour gets reached
    // for are the two places DESIGN_SYSTEM.md forbids alarming — the platform-fee caption and an
    // empty dashboard. A system that owns the token will use it there within a month.
    expect(STRIPPED).not.toMatch(/--warning/);
    expect(STRIPPED).not.toMatch(/--caution/);
  });
});

describe("design tokens — the guest terminal stays light", () => {
  it("cannot be repainted by anything above it", () => {
    // Load-bearing, not incidental: the terminal's surface is chosen on legibility — it may be
    // read in direct sunlight — so nothing outside it may darken it. Custom properties on a
    // descendant beat inherited ones regardless of ancestor specificity, which only holds while
    // the terminal is scoped to a wrapper rather than to :root.
    expect(STRIPPED).toContain('[data-surface="terminal"] {');
    expect(STRIPPED).not.toMatch(/:root\[data-surface="terminal"\]/);
    expect(surface(TERMINAL).ground).toBe(root["--n-0"]);
  });

  it("defines every surface token, so nothing inside it inherits a Portal-dark value", () => {
    // An undefined `--surface-2` here would resolve to `#262624` on a white page. The terminal
    // pins its deep surfaces to `--surface` deliberately: it is a single-purpose payment screen
    // with nothing stacked three levels down.
    const t = surface(TERMINAL);
    for (const bg of t.surfaces) {
      expect(relativeLuminance(bg)).toBeGreaterThan(0.5);
    }
  });
});

describe("design tokens — the restaurant-branding palette (its own feature, ADR-039)", () => {
  it("every palette value measures what it claims, and clears the floor", () => {
    for (const a of ACCENT_PALETTE) {
      expect(contrast(a.light, ON_ACCENT_LIGHT), `${a.id} light`).toBe(a.lightOnAccent);
      expect(contrast(a.dark, ON_ACCENT_DARK), `${a.id} dark`).toBe(a.darkOnAccent);
      expect(a.lightOnAccent).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
      expect(a.darkOnAccent).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
    }
  });

  it("no palette value is green or red — the exclusion is structural, not stylistic", () => {
    for (const a of ACCENT_PALETTE) {
      for (const value of [a.light, a.dark]) {
        const h = hue(value);
        expect(h >= 85 && h <= 170, `${a.id} ${value} sits in the success-green range`).toBe(false);
        expect(h >= 345 || h <= 20, `${a.id} ${value} sits in the error-red range`).toBe(false);
      }
    }
  });

  it("the rejected amber still fails, which is why it is kept", () => {
    for (const r of REJECTED_ACCENTS) {
      expect(contrast(r.hex, ON_ACCENT_LIGHT)).toBe(r.measuredOnAccentLight);
      expect(contrast(r.hex, ON_ACCENT_LIGHT)).toBeLessThan(CONTRAST_FLOOR);
    }
  });

  it("no longer describes the Portal's accent, and that gap is asserted rather than assumed", () => {
    // ADR-072 abolished the amber and fixed the Portal accent at one value. This palette still
    // exists as data for a feature that has not shipped, and its whole shape — a light value and
    // a dark value per accent — describes two Portal appearances that no longer exist. Asserting
    // the disconnection stops someone reading the palette as if it still governed the Portal.
    const hexes = ACCENT_PALETTE.flatMap((a) => [a.light.toLowerCase(), a.dark.toLowerCase()]);
    expect(hexes).not.toContain(ACCENT);
  });
});

describe("design tokens — the Hierarchy Law, as arithmetic", () => {
  const px = (token: string): number => Number(root[token].replace("px", ""));

  it("the hero is at least 3x body", () => {
    expect(px("--text-hero") / px("--text-body")).toBeGreaterThanOrEqual(3);
  });

  it("no other role exceeds 0.625x the hero, so a second rank-1 element is impossible", () => {
    // What makes the Hierarchy Law enforceable rather than advisory: "make it bigger" stops
    // being a specification and a review can fail on a number instead of an opinion. Survives
    // the palette change — it is about hierarchy, not taste.
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
