import { z } from "zod";

// Sprint 2 adds JWT secrets. Sprint 3 adds Stripe secrets — the first code that actually reads
// them (CLAUDE.md: "Nothing should be built just in case").
const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3001),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    REDIS_URL: z.string().min(1, "REDIS_URL is required"),
    JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
    JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900), // 15 min
    JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(604_800), // 7 days
    // ADR-038: shape validation, added after three consecutive hand-transferred secrets arrived
    // corrupted — twice wrapped in angle brackets (`<sk_test_…>`, `<whsec_…>`), once with a single
    // character silently deleted. These two were the ONLY secrets in this file still validated as
    // `min(1)` while everything else here carries a real rule, and they are precisely the two that
    // broke. The prefix and charset rules below catch the bracket class outright, at boot, naming
    // the variable — instead of the app starting cleanly and failing days later on a real business
    // call with an error about the key's PERMISSIONS rather than its INTEGRITY.
    //
    // Stated plainly so nobody mistakes this for full coverage: **none of these rules catch the
    // one-character truncation.** A 106-character key has the right prefix, the right charset, and
    // clears any honest minimum. That case is closed by StripeService's own boot-time liveness
    // probe (ADR-038 Decision 2), not here.
    //
    // The 32-character floor is a real historical floor, not a guess: Stripe's older key format was
    // `sk_test_` + 24 characters. Current keys are far longer (107), but pinning to today's length
    // would break the day Stripe issues a different one — this catches gross truncation and empty-ish
    // values without inventing a constraint Stripe never promised. `rk_` is accepted alongside `sk_`
    // because Stripe's own current guidance recommends restricted keys over secret keys; this project
    // uses `sk_` today, and rejecting `rk_` would turn that future migration into a boot failure.
    STRIPE_SECRET_KEY: z
      .string()
      .min(32, "STRIPE_SECRET_KEY is too short to be a real Stripe key")
      .regex(
        /^(sk|rk)_(test|live)_[A-Za-z0-9]+$/,
        "STRIPE_SECRET_KEY is malformed — expected sk_test_/sk_live_/rk_test_/rk_live_ followed by " +
          "alphanumerics only. Angle brackets, quotes, whitespace or a truncated prefix all fail here.",
      ),
    STRIPE_WEBHOOK_SECRET: z
      .string()
      .min(32, "STRIPE_WEBHOOK_SECRET is too short to be a real Stripe webhook secret")
      .regex(
        /^whsec_[A-Za-z0-9]+$/,
        "STRIPE_WEBHOOK_SECRET is malformed — expected whsec_ followed by alphanumerics only. " +
          "Angle brackets, quotes or whitespace all fail here.",
      ),
    // Sprint 5, Founder decision: 100 = 1.00%. Basis points (integer), not a percentage float — same
    // reasoning as ADR-001's BIGINT minor units for money itself. Required, no .default(): a fee
    // rate is a business decision, never silently assumed. "Default" in the name anticipates a
    // later per-Restaurant override (ADR-014 addendum) — this is the platform-wide fallback, not
    // necessarily the last word forever.
    DEFAULT_PLATFORM_FEE_BASIS_POINTS: z.coerce.number().int().min(0).max(10_000),
    // Where Stripe redirects the browser after onboarding (Account Links refresh_url/return_url) —
    // the Restaurant Portal, not this API. No frontend route exists at this path yet (Sprint 3 here
    // is backend-only); the redirect target is real, the page behind it isn't, same kind of gap as
    // any other "API ready, UI not built yet" state.
    FRONTEND_URL: z.string().url().default("http://localhost:3000"),
    // Sprint 11 (Security Hardening): CORS_ORIGIN replaces main.ts's previous bare `enableCors()`
    // (NestJS's own default, which reflects any Origin — OWASP A05 Security Misconfiguration). No
    // default value: which origins may call this API in production is a business decision the
    // Founder makes explicitly per environment, never silently assumed the way a fallback would.
    // Comma-separated for the (documented, not yet real) case of more than one legitimate frontend
    // origin — same "flexibility on demand of the first real case" reasoning as ADR-007/021/024/027,
    // here applied to config shape rather than code.
    CORS_ORIGIN: z
      .string()
      .min(1, "CORS_ORIGIN is required")
      .transform((v) => v.split(",").map((s) => s.trim())),
    // Sprint 13 (Deployment), ADR-031: Outbox Lag must be "a monitored, alertable metric from day
    // one, not added later" (IMPLEMENTATION_PLAN.md). Vendor-neutral — any endpoint accepting a
    // plain JSON POST works, Slack and Discord incoming webhooks both do out of the box.
    //
    // ADR-045 changed what this variable is. It was an ops convenience: alerting simply stayed
    // inactive until someone chose a channel. It is now load-bearing, and the reason is specific —
    // `main.ts`'s `unhandledRejection` handler REPORTS AND CONTINUES rather than letting the process
    // die. That is only defensible because the failure is announced; a process that degrades
    // silently is worse than the restart loop it replaced, because a restart is at least a signal a
    // platform can show. And `AlertService.sendAlert()` opens with `if (!url) return;` — a silent
    // return, no log of its own. So losing this variable in production would disable every alert in
    // the system, with nothing anywhere reporting that it had.
    //
    // Kept optional outside production: a developer's laptop must still boot without a webhook, and
    // the test suite runs with alerting inert by design. The requirement is enforced below.
    ALERT_WEBHOOK_URL: z.string().url().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;

    if (!env.ALERT_WEBHOOK_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ALERT_WEBHOOK_URL"],
        message:
          "ALERT_WEBHOOK_URL is required when NODE_ENV=production. Alerting is load-bearing " +
          "since ADR-045: main.ts reports and continues after an unhandled rejection instead of " +
          "exiting, which is only safe while failures are actually announced. Refusing to boot " +
          "is deliberate — the alternative is a service that runs with every alert silently off.",
      });
    }
  });

/**
 * A known weakness in the check above, written down rather than left for someone to discover.
 *
 * It is gated on `NODE_ENV === "production"`, and `NODE_ENV` itself carries `.default("development")`.
 * So a production deploy that lost `NODE_ENV` would fall back to development, and this requirement
 * would not fire — the guard depends on the same class of variable it exists to guard. It holds
 * today because Railway sets `NODE_ENV` explicitly (verified against the live service), and it is
 * the standard gate every environment-specific rule in this file would use. Named here so the
 * limit is on the record: this catches a lost `ALERT_WEBHOOK_URL`, not a lost `NODE_ENV`.
 */

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
