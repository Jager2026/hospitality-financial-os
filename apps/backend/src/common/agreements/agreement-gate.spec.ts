import { describe, expect, it } from "vitest";
import { AppException } from "../exceptions/app.exception";
import {
  CURRENT_PLATFORM_TERMS_VERSION,
  PLATFORM_TERMS_PLACEHOLDER,
  assertPlatformTermsPublished,
} from "./agreement-versions";

/**
 * The pre-pilot gate (ADR-055).
 *
 * **Why this test exists rather than a comment.** The gate already existed, as a sentence in
 * `IMPLEMENTATION_PLAN.md` saying the registration *screen* must not be shown. The route went on
 * accepting requests, and a real acceptance row naming a nonexistent document reached production
 * — written from a browser, found by counting rows, removed by hand. The rule was real and
 * enforced by nothing.
 *
 * Both inputs are parameters, so all four combinations are provable here without setting an
 * environment variable or editing a constant. **The falsification the Founder asked for — supply a
 * published version and registration must be allowed — is the second case below**, and it is the
 * half that stops this suite passing against a gate that simply refuses everything.
 */
const PUBLISHED = "2026-09-01";

describe("assertPlatformTermsPublished (ADR-055)", () => {
  it("REFUSES in production while the terms version is the placeholder", () => {
    let caught: unknown;
    try {
      assertPlatformTermsPublished("production", PLATFORM_TERMS_PLACEHOLDER);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppException);
    expect((caught as AppException).code).toBe("REGISTRATION_UNAVAILABLE");
    // 503, not a 4xx: nothing about the request is wrong, and the caller can do nothing about it.
    expect((caught as AppException).getStatus()).toBe(503);
  });

  it("ALLOWS in production once a real version is published — the falsification, as a test", () => {
    // Without this case the suite would pass against a gate that refuses unconditionally, which
    // would close registration permanently and look exactly like a working gate.
    expect(() => assertPlatformTermsPublished("production", PUBLISHED)).not.toThrow();
  });

  it("allows outside production, placeholder or not — so no test run has to bypass it", () => {
    // A guard that every ordinary caller must get past stops being read (CLAUDE.md, Workspace
    // Hygiene). Every test in this repository registers against the placeholder; if this refused
    // there too, the bypass would become the habit within a day.
    for (const env of ["development", "test"]) {
      expect(() => assertPlatformTermsPublished(env, PLATFORM_TERMS_PLACEHOLDER)).not.toThrow();
      expect(() => assertPlatformTermsPublished(env, PUBLISHED)).not.toThrow();
    }
  });

  it("is currently CLOSED, because the constant is still the placeholder", () => {
    // Reads the live constant rather than a copy, so this line becomes false the day the terms are
    // published. It is meant to: at that point registration opens, and whoever publishes has to
    // come here and say so deliberately instead of the gate lifting unremarked.
    //
    // There is no second switch. Publishing the document and opening registration are one edit —
    // nothing to keep in step, and nothing to forget.
    expect(CURRENT_PLATFORM_TERMS_VERSION).toBe(PLATFORM_TERMS_PLACEHOLDER);
    expect(() =>
      assertPlatformTermsPublished("production", CURRENT_PLATFORM_TERMS_VERSION),
    ).toThrow();
  });
});
