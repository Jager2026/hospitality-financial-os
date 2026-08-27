import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * Makes one rule mechanical instead of documented.
 *
 * The e2e suite clears rate-limit state between tests, and the obvious way to do that is
 * `FLUSHALL`. It would be a security bug: **token revocation lives in the same Redis under
 * `auth:`** (`token.service.ts`) — every logged-out session and every family revoked on
 * refresh-token reuse detection. A blanket flush un-revokes all of it, nothing fails, and the
 * suite goes green while the test infrastructure quietly switches off a protection this project
 * decided on in ADR-019.
 *
 * That is the worst shape available here: test infrastructure disabling a security control,
 * silently, in the one place nobody reviews for security. And the habit gets learned in tests
 * before it is applied somewhere it matters.
 *
 * A rule you can break without noticing is weaker than one you cannot break — the same reasoning
 * that left `--warning` out of the design tokens entirely rather than relying on the discipline
 * not to reach for it. So this is a test, not a paragraph in a README (there is a README too,
 * `fixtures/README.md`, for the person who wants to know why).
 *
 * The paths filter on the E2E workflow (ADR-041) includes `apps/e2e/**`, so anyone adding a
 * fixture triggers this check by the act of adding it.
 */

const E2E_ROOT = join(__dirname, "..");
const FORBIDDEN = /\b(flushall|flushdb)\b/i;
const SKIP_DIRECTORIES = new Set(["node_modules", "test-results", "playwright-report", ".git"]);

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Comments are stripped before scanning. The first version of this test flagged `throttle.ts` —
 * whose comment explains *why not* to flush — which is a false positive of exactly the kind that
 * teaches people to add ignore-comments until the check stops complaining. A comment must never
 * satisfy an assertion about code, and it must never trip one either.
 */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("no e2e fixture flushes Redis — it would silently un-revoke every token", () => {
  const offenders = sourceFiles(E2E_ROOT)
    // This file names the forbidden commands in order to forbid them.
    .filter((path) => !path.endsWith("fixture-safety.spec.ts"))
    .filter((path) => FORBIDDEN.test(code(path)));

  expect(
    offenders,
    "Clear state by key prefix instead — see resetRateLimits() in fixtures/throttle.ts and the " +
      "reasoning in fixtures/README.md. Token revocation shares this Redis under `auth:`.",
  ).toEqual([]);
});
