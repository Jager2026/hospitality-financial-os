import { notFound } from "next/navigation";
import type { JSX } from "react";
import { t } from "../../lib/i18n";

/**
 * The token layer, rendered. A design system nobody can look at drifts from the document that
 * describes it, so this page exists to make a transcription error visible rather than latent.
 *
 * ── IT DESCRIBES ONE SYSTEM (ADR-072) ────────────────────────────────────────────────────────
 * There is no theme switch here, and its removal is the point rather than a simplification. The
 * page used to pin `data-theme` on each specimen card so a dark machine could not repaint the
 * "light default" one. With the light Portal abolished those attributes match no rule, so the
 * page rendered the same surface twice with one card still captioned "light" — a specimen that
 * lies is worse than no specimen, because it is believed.
 *
 * What replaces it is what is now worth looking at: the Portal's four-step LADDER, with all three
 * text levels drawn on each step. The rule that changed in ADR-072 is that contrast is measured
 * against the deepest surface a colour can land on, and this is where that becomes visible rather
 * than merely asserted in a test.
 *
 * Development only — `notFound()` in production. It is a specimen, not a product screen, and it
 * has no place in the bundle a restaurant is served.
 */
export const dynamic = "force-static";

/** Six steps, not thirteen. The other seven served the light Portal and are gone (ADR-072). */
const RAMP = ["0", "50", "100", "500", "600", "950"] as const;

/** The Portal's surfaces, ground first. Named by the token a component would actually reach for,
 * because a specimen that shows raw values teaches the wrong habit. */
const PORTAL_LADDER = [
  { token: "--ground", label: "ground" },
  { token: "--surface", label: "surface" },
  { token: "--surface-2", label: "surface-2" },
  { token: "--surface-3", label: "surface-3 · deepest" },
] as const;

const TYPE_ROLES: { token: string; label: string; sample: string }[] = [
  { token: "text-hero", label: "48 · 700 · hero", sample: "€1,240.00" },
  { token: "text-hero-2", label: "30 · 600 · hero-2", sample: "€186.40" },
  { token: "text-title", label: "20 · 600 · title", sample: t("dashboard.topStaff") },
  { token: "text-body", label: "16 · 400 · body", sample: "Marija earned €64.20 in tips today." },
  { token: "text-small", label: "14 · 400 · small", sample: t("dashboard.todayRevenueNote") },
  { token: "text-label", label: "12 · 500 · label", sample: t("dashboard.todayRevenue") },
];

function Section({ title, children }: { title: string; children: JSX.Element }): JSX.Element {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-title font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/**
 * One step of the ladder, carrying all three text levels.
 *
 * This is the specimen that matters now. `--text-faint` measures 6.53 on the ground and 4.77 on
 * `--surface-3`; both clear the floor, and the difference between them is exactly what a reader
 * needs to see to understand why the floor is measured at the bottom of the ladder rather than
 * at the top.
 */
function LadderStep({ token, label }: { token: string; label: string }): JSX.Element {
  return (
    <div
      className="flex flex-col gap-1 rounded-portal border border-rule p-4"
      style={{ background: `var(${token})` }}
    >
      <span className="font-mono text-micro uppercase text-muted">{label}</span>
      <span className="text-body text-ink">Aa · text</span>
      <span className="text-body text-muted">Aa · muted</span>
      <span className="text-body text-faint">Aa · faint</span>
    </div>
  );
}

export default function DesignTokensPage(): JSX.Element {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-12 p-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-hero-2 font-bold">{t("design.title")}</h1>
        <p className="text-body text-muted">{t("design.subtitle")}</p>
      </header>

      <Section title={t("design.surfaces")}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2 rounded-portal border border-rule bg-surface p-6">
            <span className="text-label uppercase text-muted">{t("dashboard.todayRevenue")}</span>
            <span className="text-hero-2 font-semibold">€1,240.00</span>
            <span className="text-small text-muted">{t("dashboard.todayRevenueNote")}</span>
            <hr className="my-1 border-rule" />
            <span className="text-small">{t("design.surface.portal")}</span>
          </div>

          {/* The terminal pins its own surface on a wrapper, which is what makes it immune to
              anything above it — the one reason it is still light (ADR-072). */}
          <div
            data-surface="terminal"
            className="flex flex-col gap-2 rounded-portal border border-rule bg-ground p-6 text-ink"
          >
            <span className="text-label uppercase text-muted">{t("dashboard.todayRevenue")}</span>
            <span className="text-hero-2 font-semibold">€42.00</span>
            <span className="text-small text-muted">{t("dashboard.todayRevenueNote")}</span>
            <hr className="my-1 border-rule" />
            <span className="text-small">{t("design.surface.terminal")}</span>
          </div>
        </div>
      </Section>

      <Section title={t("design.ladder")}>
        <div className="grid gap-3 md:grid-cols-4">
          {PORTAL_LADDER.map((s) => (
            <LadderStep key={s.token} token={s.token} label={s.label} />
          ))}
        </div>
      </Section>

      <Section title={t("design.ramp")}>
        <div className="flex flex-wrap gap-1">
          {RAMP.map((step) => (
            <div key={step} className="w-16 overflow-hidden rounded border border-rule">
              <div className="h-10" style={{ background: `var(--n-${step})` }} />
              <div className="bg-surface p-1 text-center font-mono text-micro text-muted">
                {step}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title={t("design.accent")}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-4">
            <button
              type="button"
              className="h-control rounded-portal bg-accent px-4 font-semibold text-on-accent"
            >
              {t("terminal.pay")} €48.30
            </button>
            <span className="font-mono text-micro text-muted">
              --on-accent on --accent · 14.19:1
            </span>
          </div>
          <p className="max-w-prose text-small text-muted">{t("design.onAccentRule")}</p>
          <p className="max-w-prose text-small text-faint">{t("design.brandingPalette")}</p>
        </div>
      </Section>

      <Section title={t("design.semantic")}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-4">
            <span className="text-small font-semibold text-success">
              {t("state.paymentReceived")}
            </span>
            <span className="text-small font-semibold text-error">{t("state.cardDeclined")}</span>
          </div>
          <p className="max-w-prose text-small text-muted">{t("design.noWarning")}</p>
        </div>
      </Section>

      <Section title={t("design.type")}>
        <div className="flex flex-col">
          {TYPE_ROLES.map((r) => (
            <div
              key={r.token}
              className="flex flex-wrap items-baseline gap-4 border-t border-rule py-2 first:border-t-0"
            >
              <span className="w-40 shrink-0 font-mono text-micro text-muted">{r.label}</span>
              <span style={{ fontSize: `var(--${r.token})` }}>{r.sample}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title={t("design.density")}>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-2 rounded-portal border border-rule bg-surface p-4">
            <span className="font-mono text-micro uppercase text-muted">Portal · 40px · r8</span>
            <button
              type="button"
              className="h-control rounded-portal bg-accent px-4 font-semibold text-on-accent"
            >
              {t("terminal.pay")} €48.30
            </button>
          </div>
          {/* The unresolved one, left visible on purpose (ADR-072): on white the fill has almost
              no edge. Showing it is how the question stays open instead of being forgotten. */}
          <div
            data-surface="terminal"
            className="flex flex-col gap-2 rounded-portal border border-rule bg-ground p-4"
          >
            <span className="font-mono text-micro uppercase text-muted">Terminal · 56px · r12</span>
            <button
              type="button"
              className="h-control-terminal rounded-terminal bg-accent text-terminal-action font-bold text-on-accent"
            >
              {t("terminal.pay")} €48.30
            </button>
            <p className="text-small text-muted">{t("design.terminalBoundary")}</p>
          </div>
        </div>
      </Section>
    </main>
  );
}
