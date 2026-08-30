import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The CI dependency-vulnerability gate's decision logic (`.github/scripts/audit-evaluate.js`).
 *
 * Lives in this suite for the same reason as `repo-invariants.spec.ts`: it is the suite that runs
 * on every pull request, and a separate vitest project for two files would be more machinery than
 * the problem deserves. The subject is repository infrastructure, not backend behaviour.
 *
 * WHAT THIS DOES NOT COVER, stated because a green result here is easy to mistake for a working
 * gate: it exercises the decision made *about* a report, never the step that produces one. It does
 * not run `pnpm audit`, does not reach the advisory database, and cannot notice pnpm changing its
 * output format — that last risk is why `evaluate` refuses an unrecognised shape rather than
 * reading it optimistically, which is the one case below that would survive such a change.
 */

interface Advisory {
  severity: string;
  github_advisory_id: string;
  title: string;
  module_name: string;
}

type Evaluate = (
  report: unknown,
  ignored: Record<string, string>,
) => { unignored: Advisory[]; ignoredFound: Advisory[] };

let evaluate: Evaluate;
let AuditUnavailableError: new (message: string) => Error;

beforeAll(async () => {
  const modulePath = join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    ".github",
    "scripts",
    "audit-evaluate.js",
  );
  const loaded = await import(pathToFileURL(modulePath).href);
  ({ evaluate, AuditUnavailableError } = loaded.default ?? loaded);
});

function advisory(overrides: Partial<Advisory> = {}): Advisory {
  return {
    severity: "high",
    github_advisory_id: "GHSA-xxxx-yyyy-zzzz",
    title: "Prototype pollution",
    module_name: "some-package",
    ...overrides,
  };
}

function report(...advisories: Advisory[]) {
  return {
    actions: [],
    advisories: Object.fromEntries(advisories.map((a, i) => [String(i), a])),
    muted: [],
    metadata: {},
  };
}

describe("CI audit gate — evaluate()", () => {
  it("blocks a high advisory that nobody has excused", () => {
    const { unignored } = evaluate(report(advisory()), {});
    expect(unignored).toHaveLength(1);
  });

  it("lets through the same advisory once it is in the ignore list, and still reports it", () => {
    // The discriminating pair. "Blocks a high advisory" alone would pass against an implementation
    // that blocks everything and never honours the ignore list; this half is what proves the list
    // is read. The pair matters because the list is what gets edited under pressure.
    const one = advisory({ github_advisory_id: "GHSA-aaaa-bbbb-cccc" });
    const result = evaluate(report(one), { "GHSA-aaaa-bbbb-cccc": "dev-only, not reachable here" });

    expect(result.unignored).toHaveLength(0);
    expect(result.ignoredFound).toHaveLength(1);
  });

  it("ignores an entry for an advisory that is not present — an excuse is not a finding", () => {
    const result = evaluate(report(), { "GHSA-stale-entry-here": "no longer in the tree" });
    expect(result.unignored).toHaveLength(0);
    expect(result.ignoredFound).toHaveLength(0);
  });

  it("does not block below high — the gate's own threshold, asserted rather than assumed", () => {
    const result = evaluate(report(advisory({ severity: "moderate" })), {});
    expect(result.unignored).toHaveLength(0);
    expect(result.ignoredFound).toHaveLength(0);
  });

  it("refuses a report with no advisories key instead of reading it as clean", () => {
    // The case that survives pnpm changing its output. A real clean run carries
    // `advisories: {}` alongside actions/muted/metadata — verified against the pinned pnpm — so a
    // MISSING key is not an empty result, it is an unreadable one. Treating the two the same is
    // how a gate reports success for a check it never performed.
    expect(() => evaluate({ actions: [], metadata: {} }, {})).toThrow(AuditUnavailableError);
    expect(() => evaluate(null, {})).toThrow(AuditUnavailableError);
    expect(() => evaluate({ advisories: "not an object" }, {})).toThrow(AuditUnavailableError);
  });
});
