import { z } from "zod";

// Sprint 2 adds JWT secrets. Sprint 3 adds Stripe secrets — the first code that actually reads
// them (CLAUDE.md: "Nothing should be built just in case").
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
  JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900), // 15 min
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(604_800), // 7 days
  STRIPE_SECRET_KEY: z.string().min(1, "STRIPE_SECRET_KEY is required"),
  STRIPE_WEBHOOK_SECRET: z.string().min(1, "STRIPE_WEBHOOK_SECRET is required"),
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
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
