import { describe, expect, it } from "vitest";
import { validateEnv } from "./env.validation";

// ADR-038. These are not invented edge cases — all three inputs below are the literal values that
// actually reached production on this project, in order, over about two weeks. Two were caught in
// hours; the third cost eleven days and a Stripe support ticket. The point of this file is to make
// the first two impossible to repeat silently, and to state honestly, in an executable form, that
// the third is NOT covered here.
describe("env.validation — Stripe secret shape (ADR-038)", () => {
  // A realistic, obviously-fake baseline: real prefix, real charset, real length.
  const GOOD_KEY =
    `sk_test_51ShapeSpecNotARealKey${"0123456789abcdefghijklmnopqrstuvwxyz".repeat(3)}`.slice(
      0,
      107,
    );
  const GOOD_WHSEC = "whsec_ShapeSpecNotARealSecretAbc123";

  function envWith(overrides: Record<string, string>) {
    return {
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      REDIS_URL: "redis://localhost:6379",
      JWT_ACCESS_SECRET: "a".repeat(32),
      JWT_REFRESH_SECRET: "b".repeat(32),
      STRIPE_SECRET_KEY: GOOD_KEY,
      STRIPE_WEBHOOK_SECRET: GOOD_WHSEC,
      DEFAULT_PLATFORM_FEE_BASIS_POINTS: "100",
      CORS_ORIGIN: "http://localhost:3000",
      ...overrides,
    };
  }

  it("accepts a well-formed pair (baseline — without this, every rejection below could be passing for the wrong reason)", () => {
    const parsed = validateEnv(envWith({}));
    expect(parsed.STRIPE_SECRET_KEY).toBe(GOOD_KEY);
    expect(parsed.STRIPE_WEBHOOK_SECRET).toBe(GOOD_WHSEC);
  });

  // INCIDENT #1 and #2, the real values: someone pasted the documentation's own placeholder
  // punctuation along with the secret. Both reached production and both broke it.
  it("rejects an API key wrapped in angle brackets — the real incident #2 value shape", () => {
    expect(() => validateEnv(envWith({ STRIPE_SECRET_KEY: `<${GOOD_KEY}>` }))).toThrow(
      /STRIPE_SECRET_KEY is malformed/,
    );
  });

  it("rejects a webhook secret wrapped in angle brackets — the real incident #1 value shape", () => {
    expect(() => validateEnv(envWith({ STRIPE_WEBHOOK_SECRET: `<${GOOD_WHSEC}>` }))).toThrow(
      /STRIPE_WEBHOOK_SECRET is malformed/,
    );
  });

  it("rejects surrounding quotes and stray whitespace — the same class as brackets, not just the two shapes already seen", () => {
    expect(() => validateEnv(envWith({ STRIPE_SECRET_KEY: `"${GOOD_KEY}"` }))).toThrow(
      /STRIPE_SECRET_KEY is malformed/,
    );
    expect(() => validateEnv(envWith({ STRIPE_SECRET_KEY: `${GOOD_KEY} ` }))).toThrow(
      /STRIPE_SECRET_KEY is malformed/,
    );
    expect(() => validateEnv(envWith({ STRIPE_SECRET_KEY: `${GOOD_KEY}\n` }))).toThrow(
      /STRIPE_SECRET_KEY is malformed/,
    );
  });

  it("rejects a wrong or truncated prefix", () => {
    expect(() =>
      validateEnv(envWith({ STRIPE_SECRET_KEY: GOOD_KEY.replace("sk_test_", "sk_") })),
    ).toThrow(/STRIPE_SECRET_KEY is malformed/);
    expect(() =>
      validateEnv(envWith({ STRIPE_WEBHOOK_SECRET: "wsec_missingAnH123456789012345678901234" })),
    ).toThrow(/STRIPE_WEBHOOK_SECRET is malformed/);
  });

  it("accepts rk_ restricted keys — Stripe's own current guidance prefers them over sk_, and rejecting them would turn that migration into a boot failure", () => {
    const restricted = GOOD_KEY.replace("sk_test_", "rk_test_");
    expect(validateEnv(envWith({ STRIPE_SECRET_KEY: restricted })).STRIPE_SECRET_KEY).toBe(
      restricted,
    );
  });

  // INCIDENT #3 — the expensive one. This test asserts the OPPOSITE of what the others do, on
  // purpose. Shape validation cannot see a single deleted character: the value still has the right
  // prefix, the right charset, and clears any honest length floor. Documenting that here in
  // executable form means nobody can later read this file and conclude the shape rules made the
  // liveness probe redundant — if this ever starts failing because someone pinned an exact length,
  // that is a deliberate decision to re-argue, not a silent tightening.
  it("does NOT catch a one-character truncation — this is the gap StripeService's boot probe exists to close, asserted rather than assumed", () => {
    const truncated = GOOD_KEY.slice(0, 105) + GOOD_KEY.slice(106);
    expect(truncated.length).toBe(GOOD_KEY.length - 1);
    expect(() => validateEnv(envWith({ STRIPE_SECRET_KEY: truncated }))).not.toThrow();
  });

  it("still rejects a grossly truncated key, so the length floor is doing real work", () => {
    expect(() => validateEnv(envWith({ STRIPE_SECRET_KEY: "sk_test_51Short" }))).toThrow(
      /STRIPE_SECRET_KEY is too short/,
    );
  });

  // Hoisted: both production rules below need a value the other rule accepts, otherwise every
  // "boots in production" case would fail on the rule it is not testing.
  const WEBHOOK = "https://hooks.example.com/services/T000/B000/XXXX";
  const PROD_FRONTEND = "https://portal.example.com";

  // ADR-045. ALERT_WEBHOOK_URL stopped being an ops convenience the moment main.ts began
  // reporting-and-continuing after an unhandled rejection instead of exiting. All three cases are
  // required together: the rejection alone would pass against an implementation that demands the
  // variable everywhere (which would break every developer machine and the test suite), and the
  // acceptances alone would pass against no rule at all.
  describe("ALERT_WEBHOOK_URL is required in production (ADR-045)", () => {
    it("refuses to boot in production without it — alerting off is not a state we start in", () => {
      expect(() => validateEnv(envWith({ NODE_ENV: "production" }))).toThrow(
        /ALERT_WEBHOOK_URL is required when NODE_ENV=production/,
      );
    });

    it("boots in production with it", () => {
      const parsed = validateEnv(
        envWith({
          NODE_ENV: "production",
          ALERT_WEBHOOK_URL: WEBHOOK,
          FRONTEND_URL: PROD_FRONTEND,
        }),
      );
      expect(parsed.ALERT_WEBHOOK_URL).toBe(WEBHOOK);
    });

    it("stays optional outside production — a developer machine and the test suite must still boot", () => {
      expect(() => validateEnv(envWith({ NODE_ENV: "development" }))).not.toThrow();
      expect(() => validateEnv(envWith({ NODE_ENV: "test" }))).not.toThrow();
    });

    it("does NOT fire when NODE_ENV itself is missing — the guard's own stated limit, asserted rather than assumed", () => {
      // NODE_ENV carries .default("development"), so an environment that lost it falls back and
      // this rule never runs. Production sets NODE_ENV explicitly, which is what makes the rule
      // effective there; this test exists so the dependency is visible instead of implied.
      expect(() => validateEnv(envWith({}))).not.toThrow();
    });
  });

  // The Stripe onboarding return_url. Unlike ALERT_WEBHOOK_URL this variable has a localhost
  // DEFAULT, so "unset" and "explicitly localhost" are the same value by the time validation sees
  // it — which is why the rule constrains the host rather than requiring presence.
  describe("FRONTEND_URL must not be a loopback address in production", () => {
    it("rejects the localhost default — the silent failure at the end of onboarding", () => {
      expect(() =>
        validateEnv(envWith({ NODE_ENV: "production", ALERT_WEBHOOK_URL: WEBHOOK })),
      ).toThrow(/FRONTEND_URL must not point at a loopback address/);
    });

    it("rejects loopback in every shape it actually takes, not just the literal string", () => {
      // A substring check on "localhost" would pass three of these four and is exactly the kind of
      // implementation this test exists to fail against.
      for (const url of [
        "http://127.0.0.1:3000",
        "http://127.1.2.3:3000",
        "http://LOCALHOST:3000",
        "http://[::1]:3000",
      ]) {
        expect(() =>
          validateEnv(
            envWith({ NODE_ENV: "production", ALERT_WEBHOOK_URL: WEBHOOK, FRONTEND_URL: url }),
          ),
        ).toThrow(/FRONTEND_URL must not point at a loopback address/);
      }
    });

    it("accepts a real production origin", () => {
      const parsed = validateEnv(
        envWith({
          NODE_ENV: "production",
          ALERT_WEBHOOK_URL: WEBHOOK,
          FRONTEND_URL: PROD_FRONTEND,
        }),
      );
      expect(parsed.FRONTEND_URL).toBe(PROD_FRONTEND);
    });

    it("does not flag a legitimate host that merely contains the word", () => {
      const parsed = validateEnv(
        envWith({
          NODE_ENV: "production",
          ALERT_WEBHOOK_URL: WEBHOOK,
          FRONTEND_URL: "https://localhost-tools.example.com",
        }),
      );
      expect(parsed.FRONTEND_URL).toBe("https://localhost-tools.example.com");
    });

    it("leaves the localhost default alone outside production — that is what it is for", () => {
      expect(() => validateEnv(envWith({ NODE_ENV: "development" }))).not.toThrow();
      expect(() => validateEnv(envWith({ NODE_ENV: "test" }))).not.toThrow();
    });
  });
});
