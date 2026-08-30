import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-public-env.mjs");

/**
 * The guard, exercised as a real process rather than by importing its logic.
 *
 * It has to be a subprocess: the script's whole contract is an exit code, and it reads
 * `process.env` at module load. Importing it would let this file's own environment leak in, and
 * would test a rearranged copy of the guard rather than the guard.
 *
 * **This exists because the guard was broken in a way no amount of reading it revealed.** Its
 * activation was conditional on `NODE_ENV === "production"`, which CI never set — so it exited 0
 * on every pull request without reading anything, and looked, in its own log line, like it had
 * decided something. A gate that reports "nothing to check here" is indistinguishable from a gate
 * that passed, and that is the failure this file is built to catch if it ever returns.
 *
 * Every case below is a pair: one input that MUST be refused and one that MUST be accepted. A
 * check that only ever sees rejections passes just as well when it rejects everything.
 */
function run(env: Record<string, string | undefined>): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [SCRIPT], {
      // A deliberately clean environment. Inheriting `process.env` would carry the developer's own
      // NEXT_PUBLIC_API_URL into the "not set" case and quietly turn it into a different test.
      env: { PATH: process.env.PATH, ...env } as NodeJS.ProcessEnv,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    // `?? ""` on each half, not on the pair: when a spawn fails outright both are `undefined`,
    // and when the script merely exits non-zero stdout is `""` — a present value, not an absent
    // one, so a single `??` over a concatenation would never fire (CLAUDE.md, Workspace Hygiene).
    return { code: e.status ?? -1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("check-public-env — the frontend build guard", () => {
  it("refuses a build with no NEXT_PUBLIC_API_URL, and accepts one with a real URL", () => {
    const missing = run({});
    expect(missing.code).toBe(1);
    expect(missing.output).toContain("NEXT_PUBLIC_API_URL is not set");

    const real = run({ NEXT_PUBLIC_API_URL: "https://api.plaintabs.com" });
    expect(real.code).toBe(0);
  });

  it("refuses a loopback URL, in every spelling of loopback", () => {
    for (const url of [
      "http://localhost:3001",
      "http://127.0.0.1:3001",
      "http://[::1]:3001",
      "http://LOCALHOST:3001",
      "http://localhost.:3001",
      "http://127.9.9.9:3001",
    ]) {
      const result = run({ NEXT_PUBLIC_API_URL: url });
      expect(result.code, `${url} should have been refused`).toBe(1);
      expect(result.output).toContain("loopback");
    }
  });

  it("does not refuse a real host that merely contains the word localhost", () => {
    // The other half of the pair above: a guard that rejected every URL would pass all of it.
    const result = run({ NEXT_PUBLIC_API_URL: "https://localhost.plaintabs.com" });
    expect(result.code).toBe(0);
  });

  // The regression this file exists for. Before the fix, an unset NODE_ENV — CI's actual state —
  // made the guard exit 0 while printing that localhost defaults were fine. The guard's decision
  // must now come from the VALUE, so that an absent environment label cannot switch it off.
  it("checks the value regardless of NODE_ENV — an absent environment label is not permission", () => {
    for (const nodeEnv of [undefined, "development", "test", "production"]) {
      const result = run({ NODE_ENV: nodeEnv, NEXT_PUBLIC_API_URL: "http://localhost:3001" });
      expect(result.code, `NODE_ENV=${String(nodeEnv)} should not disable the guard`).toBe(1);
    }
  });

  it('allows loopback only when a build says so explicitly, and only for an exact "1"', () => {
    const allowed = run({
      NEXT_PUBLIC_API_URL: "http://localhost:3101",
      ALLOW_LOOPBACK_API_URL: "1",
    });
    expect(allowed.code).toBe(0);
    expect(allowed.output).toContain("allowed explicitly");

    // An empty string is a present value. `ALLOW_LOOPBACK_API_URL=` left in a shell must not read
    // as permission — the fifth time this distinction has decided a behaviour in this codebase.
    for (const value of ["", "0", "true", "yes"]) {
      const result = run({
        NEXT_PUBLIC_API_URL: "http://localhost:3101",
        ALLOW_LOOPBACK_API_URL: value,
      });
      expect(result.code, `ALLOW_LOOPBACK_API_URL="${value}" must not grant permission`).toBe(1);
    }
  });
});
