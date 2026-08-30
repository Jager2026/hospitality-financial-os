#!/usr/bin/env node
// @ts-check
/**
 * Build-time guard on the public API URL. Runs before `next build`.
 *
 * The backend already refuses to boot in production with a loopback `FRONTEND_URL` (ADR-045). This
 * is the same defect on the other side of the wire, and it shipped: `NEXT_PUBLIC_API_URL` was never
 * set on the production frontend service, `client.ts` fell back to `http://localhost:3001`, and the
 * deployed login page tried to reach the visitor's own machine. **Production had never worked in a
 * browser**, while the API, the tests and every deploy were green.
 *
 * Why a BUILD-time check rather than a runtime one, and this is the whole reason the file exists:
 * `NEXT_PUBLIC_*` is inlined by Next at build time. Setting the variable on a running service
 * changes nothing until a rebuild — so the last moment the value can still be corrected is here,
 * before the bundle is written. A runtime check would fail in the visitor's browser, after deploy,
 * which is far too late to be a guard.
 *
 * The backend's equivalent refuses to BOOT. A statically-built frontend has no equivalent moment,
 * so it refuses to BUILD.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * **This guard used to have an off switch, and it was on in the one place that runs it most.**
 *
 * Its first version activated only when `NODE_ENV === "production" || RAILWAY_ENVIRONMENT ===
 * "production"`. Neither variable is set in CI, so on every pull request this file printed
 * "non-production build — localhost defaults are fine here" and exited 0 **without reading
 * `NEXT_PUBLIC_API_URL` at all.** The guard written in response to a production outage had never
 * once run outside Railway. Confirmed by executing it in CI's exact environment, both ways, not
 * by reading the condition.
 *
 * ADR-045 already recorded the class — *a conditional guard is only as reliable as the thing it is
 * conditional on* — and closed it for the NestJS app by making `NODE_ENV` a required, validated
 * variable with no default. **That fix does not reach here, and the reason is the part worth
 * carrying:** this is a different process. `validateEnv` never runs in it. Inside the app,
 * `NODE_ENV` cannot go missing without the boot failing loudly; in a build script it is just
 * another unset variable, and an unset variable reads as "not production" — which is exactly the
 * answer that switches the guard off. **The same variable is trustworthy in one process and not in
 * another, and what makes the difference is whether anything validates it there.**
 *
 * So the activation condition is gone rather than corrected. This now runs on EVERY build and
 * decides on the **value**, which is observable, instead of on an environment label, which is not.
 *
 * The one build that legitimately wants a loopback URL — the Playwright harness, which points the
 * bundle at its own backend on 127.0.0.1 — says so explicitly via `ALLOW_LOOPBACK_API_URL=1`, set
 * in `apps/e2e/scripts/build-apps.mjs` and nowhere else. Same shape as ADR-048's
 * `--allow-revocations`: the dangerous half is a visible line in a reviewed file, and its absence
 * is the decision. It is deliberately not an allowlist of "environments where this is fine" —
 * that is the list someone edits to make a build green.
 */

/** The single legitimate loopback build. Checked as an exact "1" rather than truthiness: an empty
 * string is a present value, and `ALLOW_LOOPBACK_API_URL=` left in a shell would otherwise read as
 * permission it never granted. */
const allowLoopback = process.env.ALLOW_LOOPBACK_API_URL === "1";

const url = process.env.NEXT_PUBLIC_API_URL;

/** @param {string} value */
function isLoopback(value) {
  let host;
  try {
    host = new URL(value).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** @param {...string} lines @returns {never} */
function fail(...lines) {
  console.error("\n  Refusing to build the frontend.\n");
  for (const line of lines) console.error(`  ${line}`);
  console.error(
    "\n  NEXT_PUBLIC_* values are inlined at BUILD time — setting the variable on a running\n" +
      "  service changes nothing until the service is rebuilt. This is the last moment it can\n" +
      "  still be fixed.\n" +
      "\n  A build that deliberately targets a loopback backend (the Playwright harness) sets\n" +
      "  ALLOW_LOOPBACK_API_URL=1 to say so. To build locally against your own dev API:\n" +
      "    NEXT_PUBLIC_API_URL=http://localhost:3001 ALLOW_LOOPBACK_API_URL=1 pnpm run build\n",
  );
  process.exit(1);
}

if (!url) {
  fail(
    "NEXT_PUBLIC_API_URL is not set.",
    "The client would fall back to http://localhost:3001 — the visitor's own machine.",
  );
}

if (isLoopback(url) && !allowLoopback) {
  fail(
    `NEXT_PUBLIC_API_URL points at a loopback address ("${url}").`,
    "Every browser would try to reach the API on the visitor's own machine.",
  );
}

if (isLoopback(url)) {
  console.log(`[check-public-env] NEXT_PUBLIC_API_URL = ${url} — loopback, allowed explicitly.`);
} else {
  console.log(`[check-public-env] NEXT_PUBLIC_API_URL = ${url} — not loopback, proceeding.`);
}
