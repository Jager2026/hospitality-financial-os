import type { Config } from "tailwindcss";

/**
 * Tailwind reads the token layer; it never restates it.
 *
 * Every colour, size and space below points at a CSS custom property defined in
 * `src/styles/tokens.css`. That indirection is the whole point: a surface change or a
 * restaurant's own accent swaps one variable, and both Tailwind classes and any hand-written
 * CSS see the same new value. If Tailwind held its own hex values instead, we would have two
 * copies of every colour and exactly the drift `DESIGN_SYSTEM.md` forbids — the same reasoning
 * ADR-039 applies to duplicated access checks.
 *
 * The ramp (`--n-*`) is deliberately NOT exposed as utilities. Components use semantic names
 * only, so "which grey" is a decision the token layer already made.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ground: "var(--ground)",
        surface: "var(--surface)",
        // ADR-072: the Portal ladder deepens, and the floor is measured at the bottom of it.
        // Without these two the deep surfaces exist in CSS and are unreachable from a class,
        // which is how a token layer quietly stops being the thing screens actually use.
        "surface-2": "var(--surface-2)",
        "surface-3": "var(--surface-3)",
        ink: "var(--text)",
        muted: "var(--text-muted)",
        faint: "var(--text-faint)",
        rule: "var(--rule)",
        accent: "var(--accent)",
        "on-accent": "var(--on-accent)",
        success: "var(--success)",
        error: "var(--error)",
        // No `warning`. DESIGN_SYSTEM.md: the two places one gets reached for are the two
        // places the document forbids alarming. Not having the token is cheaper than the
        // discipline of not using it.
      },
      fontFamily: {
        sans: ["var(--font-plex-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-plex-mono)", "ui-monospace", "monospace"],
      },
      fontSize: {
        hero: ["var(--text-hero)", { lineHeight: "1", letterSpacing: "var(--tracking-hero)" }],
        "hero-2": [
          "var(--text-hero-2)",
          { lineHeight: "1.05", letterSpacing: "var(--tracking-hero-2)" },
        ],
        title: ["var(--text-title)", { lineHeight: "1.3", letterSpacing: "var(--tracking-title)" }],
        body: ["var(--text-body)", { lineHeight: "1.6" }],
        small: ["var(--text-small)", { lineHeight: "1.55" }],
        label: ["var(--text-label)", { lineHeight: "1.4", letterSpacing: "var(--tracking-label)" }],
        micro: ["var(--text-micro)", { lineHeight: "1.4", letterSpacing: "var(--tracking-micro)" }],
        "terminal-amount": ["var(--text-terminal-amount)", { lineHeight: "1" }],
        "terminal-action": ["var(--text-terminal-action)", { lineHeight: "1.2" }],
      },
      spacing: {
        1: "var(--space-1)",
        2: "var(--space-2)",
        3: "var(--space-3)",
        4: "var(--space-4)",
        6: "var(--space-6)",
        8: "var(--space-8)",
        12: "var(--space-12)",
        16: "var(--space-16)",
        24: "var(--space-24)",
      },
      borderRadius: {
        portal: "var(--radius-portal)",
        terminal: "var(--radius-terminal)",
      },
      height: {
        control: "var(--control-portal)",
        "control-terminal": "var(--control-terminal)",
        row: "var(--row-portal)",
      },
      minHeight: {
        target: "var(--target-min)",
      },
      minWidth: {
        target: "var(--target-min)",
      },
    },
  },
  plugins: [],
};

export default config;
