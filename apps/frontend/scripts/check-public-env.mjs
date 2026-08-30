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
 */

const isProductionBuild =
  process.env.NODE_ENV === "production" || process.env.RAILWAY_ENVIRONMENT === "production";

if (!isProductionBuild) {
  console.log("[check-public-env] non-production build — localhost defaults are fine here.");
  process.exit(0);
}

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
  console.error("\n  Refusing to build the production frontend.\n");
  for (const line of lines) console.error(`  ${line}`);
  console.error(
    "\n  NEXT_PUBLIC_* values are inlined at BUILD time — setting the variable on a running\n" +
      "  service changes nothing until the service is rebuilt. This is the last moment it can\n" +
      "  still be fixed.\n",
  );
  process.exit(1);
}

if (!url) {
  fail(
    "NEXT_PUBLIC_API_URL is not set.",
    "The client would fall back to http://localhost:3001 — the visitor's own machine.",
  );
}

if (isLoopback(url)) {
  fail(
    `NEXT_PUBLIC_API_URL points at a loopback address ("${url}").`,
    "Every browser would try to reach the API on the visitor's own machine.",
  );
}

console.log(`[check-public-env] NEXT_PUBLIC_API_URL = ${url} — not loopback, proceeding.`);
