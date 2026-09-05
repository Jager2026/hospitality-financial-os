import { defineConfig, devices } from "@playwright/test";

/**
 * Browser end-to-end harness — ADR-041.
 *
 * The seam is not invented here. `apps/backend/src/e2e/critical-flow.e2e.spec.ts` already states
 * this codebase's rule in its own comment: **only the literal outbound network call is replaced**,
 * and every real Controller, Guard, Service, Prisma client and Ledger write runs unmodified under
 * real HTTP. This harness adopts that identical seam one layer up, and for the login flow it
 * replaces nothing at all — Stripe is not involved, and the breached-password check runs at
 * registration and invitation-acceptance, never at login (`API_Contract.md`).
 *
 * So the chain under test is genuinely: real browser -> real Next.js -> real NestJS -> real
 * Postgres -> real bcrypt.
 *
 * The harness is built and proved BEFORE the first screen exists, deliberately — the same reason
 * the token layer was transcribed in full before its first consumer. Verification infrastructure
 * shaped by the screen it was written for tends to test what that screen happens to do.
 */

const BACKEND_PORT = 3101;
const FRONTEND_PORT = 3100;

/** A database of its own, on the same Postgres the rest of the project uses (docker-compose,
 * ADR-034's `postgres:18`). Separate so a run can truncate freely without touching whatever a
 * developer has in their dev database — the reconciliation suite has already been derailed once
 * by accumulated local rows, and an e2e run creates users on every execution. */
const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://hospitality:hospitality@localhost:5432/hospitality_os_e2e";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * Placeholders exist only so `env.validation.ts` lets the app boot (ADR-038 shape rules). Nothing
 * in this harness makes a Stripe call — the login flow does not touch Stripe at all — so these
 * never need to be working credentials, only well-formed. Same reasoning as the CI workflow's own
 * placeholders, and the same reason they are composed here rather than written as literals:
 * GitHub's push protection reads a realistic-looking `sk_test_` literal as a leaked key, and the
 * right answer to that is not to lengthen the string until the scanner stops noticing.
 */
const STRIPE_SECRET_KEY = ["sk", "test", "e2eharnessplaceholderneverusedonnetwork"].join("_");
const STRIPE_WEBHOOK_SECRET = ["whsec", "e2eharnessplaceholderneververifiesarealevent"].join("_");
// ADR-069 made RESEND_API_KEY required at boot, and the harness composes the backend env itself —
// so it had to be added HERE, not in the workflow. The underscore in the middle is not decoration:
// a real Resend key is re_<id>_<secret>, and a placeholder without it would pass a rule real keys
// fail. Nothing here sends: EmailService refuses outside production (ADR-070).
const RESEND_API_KEY = ["re", "e2eharnessplaceholder", "neverusedonnetwork"].join("_");

const backendEnv: Record<string, string> = {
  NODE_ENV: "test",
  PORT: String(BACKEND_PORT),
  DATABASE_URL: E2E_DATABASE_URL,
  REDIS_URL,
  JWT_ACCESS_SECRET: "e2e_placeholder_access_secret_not_a_real_secret_32chars",
  JWT_REFRESH_SECRET: "e2e_placeholder_refresh_secret_not_a_real_secret_32chars",
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  RESEND_API_KEY,
  DEFAULT_PLATFORM_FEE_BASIS_POINTS: "100",
  CORS_ORIGIN: `http://localhost:${FRONTEND_PORT}`,
  FRONTEND_URL: `http://localhost:${FRONTEND_PORT}`,
};

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false, // one shared backend process; see ADR-041 on throttle state
  forbidOnly: !!process.env.CI,
  retries: 0, // deliberately none — see the note in tests/harness.spec.ts on why a retry here
  // would hide exactly the failures this harness exists to surface
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],

  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  /* Both servers are the real ones, started from the real build scripts. `reuseExistingServer` is
   * off in CI so a run can never silently pass against a stale process. */
  webServer: [
    {
      command: "pnpm --filter backend run start",
      port: BACKEND_PORT,
      env: backendEnv,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `pnpm --filter frontend run start --port ${FRONTEND_PORT}`,
      port: FRONTEND_PORT,
      env: { NEXT_PUBLIC_API_URL: `http://localhost:${BACKEND_PORT}` },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});

export { BACKEND_PORT, FRONTEND_PORT, E2E_DATABASE_URL, REDIS_URL };
