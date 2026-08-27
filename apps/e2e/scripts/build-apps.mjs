import { execSync } from "node:child_process";

/**
 * Builds both apps with the ports this harness actually uses.
 *
 * `NEXT_PUBLIC_*` is inlined at BUILD time, not read at runtime — so setting `NEXT_PUBLIC_API_URL`
 * in Playwright's `webServer.env` does nothing: `next start` serves a bundle that already has
 * whatever value was compiled in. The first run of the login suite failed exactly this way, and
 * the symptom was misleading: the browser stayed on /login as though the password were wrong,
 * because the page was calling `localhost:3001` (the default, i.e. the developer's own dev
 * backend) instead of the harness's backend on 3101. Confirmed by finding the literal in the
 * built chunk, not inferred.
 */
const BACKEND_PORT = process.env.E2E_BACKEND_PORT ?? "3101";

const env = {
  ...process.env,
  NEXT_PUBLIC_API_URL: `http://localhost:${BACKEND_PORT}`,
};

execSync("pnpm --filter backend run build", { cwd: "../..", env, stdio: "inherit" });
execSync("pnpm --filter frontend run build", { cwd: "../..", env, stdio: "inherit" });
