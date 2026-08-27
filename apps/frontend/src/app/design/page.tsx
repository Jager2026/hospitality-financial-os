import { notFound } from "next/navigation";
import type { JSX } from "react";
import { t } from "../../lib/i18n";
import { ACCENT_PALETTE, ON_ACCENT_DARK, ON_ACCENT_LIGHT } from "../../styles/accent-palette";

/**
 * The token layer, rendered. A design system nobody can look at drifts from the document that
 * describes it, so this page exists to make a transcription error visible rather than latent.
 *
 * Development only — `notFound()` in production. It is a specimen, not a product screen, and it
 * has no place in the bundle a restaurant is served.
 */
export const dynamic = "force-static";

const RAMP = [
  "0",
  "25",
  "50",
  "100",
  "200",
  "300",
  "400",
  "500",
  "600",
  "700",
  "800",
  "900",
  "950",
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

/** One surface rendered in its own tokens, so a wrong value is visible rather than described. */
function SurfaceCard({
  label,
  surface,
  amount,
}: {
  label: string;
  surface?: "terminal" | "dark" | "light";
  amount: string;
}): JSX.Element {
  // Each card pins its own surface rather than inheriting one. Without that, on a machine set
  // to dark the "light default" card renders dark and the specimen quietly shows two of the
  // same thing — which is exactly what happened the first time this page was run.
  const attrs =
    surface === "terminal"
      ? { "data-surface": "terminal" as const }
      : surface === "dark"
        ? { "data-theme": "dark" as const }
        : { "data-theme": "light" as const };
  return (
    <div
      {...attrs}
      className="flex flex-col gap-2 rounded-portal border border-rule bg-ground p-6 text-ink"
    >
      <span className="text-label uppercase text-muted">{t("dashboard.todayRevenue")}</span>
      <span className="text-hero-2 font-semibold">{amount}</span>
      <span className="text-small text-muted">{t("dashboard.todayRevenueNote")}</span>
      <hr className="my-1 border-rule" />
      <span className="text-small">{label}</span>
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
        <div className="grid gap-4 md:grid-cols-3">
          <SurfaceCard label={t("design.surface.portalLight")} amount="€1,240.00" />
          <SurfaceCard label={t("design.surface.portalDark")} surface="dark" amount="€1,240.00" />
          <SurfaceCard label={t("design.surface.terminal")} surface="terminal" amount="€42.00" />
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
        <div className="flex flex-col">
          {ACCENT_PALETTE.map((a) => (
            <div
              key={a.id}
              className="flex flex-wrap items-center gap-4 border-t border-rule py-3 first:border-t-0"
            >
              <span className="w-28 text-small font-semibold">
                {a.label}
                <span className="block font-mono text-micro font-normal text-muted">{a.light}</span>
              </span>
              <span className="flex items-center gap-2">
                <span
                  className="rounded-portal px-4 py-2 text-small font-bold"
                  style={{ background: a.light, color: ON_ACCENT_LIGHT }}
                >
                  {t("terminal.pay")} €48.30
                </span>
                <span className="font-mono text-micro text-muted">{a.lightOnAccent}:1</span>
              </span>
              <span className="flex items-center gap-2">
                <span
                  className="rounded-portal px-4 py-2 text-small font-bold"
                  style={{ background: a.dark, color: ON_ACCENT_DARK }}
                >
                  {t("terminal.pay")} €48.30
                </span>
                <span className="font-mono text-micro text-muted">{a.darkOnAccent}:1</span>
              </span>
            </div>
          ))}
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
          </div>
        </div>
      </Section>
    </main>
  );
}
