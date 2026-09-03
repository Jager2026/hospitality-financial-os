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
  // ADR-069. Shaped like a REAL Resend key — `re_<id>_<secret>` — because the underscore in the
  // middle is the whole reason this constant is written out rather than reusing a Stripe-ish one.
  const GOOD_RESEND_KEY = "re_ExampleId_ThisIsNotARealResendKey0123";

  function envWith(overrides: Record<string, string>) {
    return {
      // Explicit since NODE_ENV lost its default — the value vitest itself sets, so the base case
      // matches how the suite really runs rather than inventing a shape.
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      REDIS_URL: "redis://localhost:6379",
      JWT_ACCESS_SECRET: "a".repeat(32),
      JWT_REFRESH_SECRET: "b".repeat(32),
      STRIPE_SECRET_KEY: GOOD_KEY,
      STRIPE_WEBHOOK_SECRET: GOOD_WHSEC,
      DEFAULT_PLATFORM_FEE_BASIS_POINTS: "100",
      CORS_ORIGIN: "http://localhost:3000",
      RESEND_API_KEY: GOOD_RESEND_KEY,
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

    // This test used to assert the opposite, and the change is the point. While NODE_ENV carried
    // .default("development"), an environment that lost it fell back silently and every production
    // rule in this file stopped firing — the gate could go missing on its own. NODE_ENV is now
    // required, so the gate cannot disappear without the boot failing and naming it.
    it("cannot be bypassed by losing NODE_ENV itself — the gate every production rule hangs on is now required", () => {
      const { NODE_ENV: _omitted, ...withoutNodeEnv } = envWith({});
      expect(() => validateEnv(withoutNodeEnv)).toThrow(/NODE_ENV/);
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

  // ADR-069 — the Resend key shape.
  //
  // THE FIRST TEST HERE IS THE ONE THAT MATTERS, and it is a discriminating test in the strict
  // sense: the obvious implementation of this rule is to copy the Stripe regex above and change
  // the prefix, giving /^re_[A-Za-z0-9]+$/. That version REJECTS every real Resend key, because a
  // real key is re_<id>_<secret> and carries an underscore in its body. It would have passed every
  // other assertion in this block and refused to boot production on the first deploy.
  describe("Resend key shape (ADR-069)", () => {
    it(
      "accepts a real-shaped key, WITH the underscore inside the body — the Stripe regex with a " +
        "swapped prefix fails this and nothing else, which is why it is written first",
      () => {
        const parsed = validateEnv(envWith({}));
        expect(parsed.RESEND_API_KEY).toBe(GOOD_RESEND_KEY);
        // Stated explicitly so the reason survives someone tidying the constant later.
        expect(GOOD_RESEND_KEY.slice(3)).toContain("_");
      },
    );

    it("rejects the wrong prefix, the missing prefix, and a truncated one", () => {
      expect(() => validateEnv(envWith({ RESEND_API_KEY: "sk_test_" + "a".repeat(40) }))).toThrow(
        /RESEND_API_KEY is malformed/,
      );
      expect(() => validateEnv(envWith({ RESEND_API_KEY: "a".repeat(40) }))).toThrow(
        /RESEND_API_KEY is malformed/,
      );
      expect(() => validateEnv(envWith({ RESEND_API_KEY: "re" + "a".repeat(40) }))).toThrow(
        /RESEND_API_KEY is malformed/,
      );
    });

    it("rejects the shapes a copy-paste actually produces — quotes, angle brackets, whitespace", () => {
      expect(() => validateEnv(envWith({ RESEND_API_KEY: `<${GOOD_RESEND_KEY}>` }))).toThrow(
        /RESEND_API_KEY is malformed/,
      );
      expect(() => validateEnv(envWith({ RESEND_API_KEY: `"${GOOD_RESEND_KEY}"` }))).toThrow(
        /RESEND_API_KEY is malformed/,
      );
      expect(() => validateEnv(envWith({ RESEND_API_KEY: `${GOOD_RESEND_KEY} ` }))).toThrow(
        /RESEND_API_KEY is malformed/,
      );
      expect(() =>
        validateEnv(
          envWith({
            RESEND_API_KEY: `${GOOD_RESEND_KEY}
`,
          }),
        ),
      ).toThrow(/RESEND_API_KEY is malformed/);
    });

    it(
      "rejects absent and rejects EMPTY — the two are different states, and this project has been " +
        "bitten three times by code that only checked one of them",
      () => {
        const { RESEND_API_KEY: _omitted, ...withoutKey } = envWith({});
        expect(() => validateEnv(withoutKey)).toThrow(/RESEND_API_KEY/);
        expect(() => validateEnv(envWith({ RESEND_API_KEY: "" }))).toThrow(/RESEND_API_KEY/);
      },
    );

    it(
      "is required in EVERY environment, not only production — it is the gate the whole email " +
        "path hangs from, and ADR-045 says a gate cannot itself be conditional",
      () => {
        for (const NODE_ENV of ["development", "test", "production"]) {
          const { RESEND_API_KEY: _omitted, ...withoutKey } = envWith({ NODE_ENV });
          expect(() => validateEnv({ ...withoutKey, NODE_ENV })).toThrow(/RESEND_API_KEY/);
        }
      },
    );
  });
});
