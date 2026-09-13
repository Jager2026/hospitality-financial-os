#!/usr/bin/env node
// @ts-check
/**
 * Brings the Portal up on this machine with something to look at on every screen.
 *
 * **Why this is a script and not a chain of `&&` in package.json.** The steps are not all the same
 * kind of thing: one starts containers and has to WAIT for them, one applies migrations, one seeds,
 * and the last never returns because it is a dev server. A shell chain gets the first three right
 * and then hides which of them failed, because pnpm prints its own error over theirs. This prints
 * each step as it starts, so a failure names itself.
 *
 * **It is local-only twice over.** `docker compose` points at `docker/docker-compose.yml`, which is
 * a developer's own Postgres; and the seed script refuses to run against any database that is not
 * on this machine or a private network, asking the server where it is rather than trusting the
 * connection string. Production is reached only through Railway's tooling, which is not here.
 *
 * Usage:  pnpm run demo:portal
 */
const { execSync, spawnSync } = require("node:child_process");
const { resolve } = require("node:path");

const ROOT = resolve(__dirname, "..");
const COMPOSE = ["compose", "-f", "docker/docker-compose.yml"];

/** @param {string} label @param {string} command */
function step(label, command) {
  console.log(`\n▸ ${label}`);
  execSync(command, { cwd: ROOT, stdio: "inherit" });
}

function waitForPostgres() {
  console.log("\n▸ Waiting for Postgres to answer");
  // Twenty attempts at a second apart. A fixed sleep is the alternative and it is wrong in both
  // directions: too short on a cold start, and pure waste every other time.
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const probe = spawnSync(
      "docker",
      [...COMPOSE, "exec", "-T", "postgres", "pg_isready", "-U", "hospitality"],
      { cwd: ROOT, stdio: "ignore" },
    );
    if (probe.status === 0) {
      console.log(`  ready after ${attempt} ${attempt === 1 ? "attempt" : "attempts"}`);
      return;
    }
    execSync(process.platform === "win32" ? "timeout /t 1 /nobreak >nul" : "sleep 1", {
      cwd: ROOT,
      stdio: "ignore",
    });
  }
  throw new Error(
    "Postgres did not become ready in 20 seconds. `docker compose -f docker/docker-compose.yml ps` " +
      "will say what its container is doing.",
  );
}

try {
  step("Starting Postgres and Redis", `docker ${COMPOSE.join(" ")} up -d`);
  waitForPostgres();
  step("Applying migrations", "pnpm --filter backend run prisma:migrate:deploy");
  step("Seeding reference data", "pnpm --filter backend run prisma:seed");
  step("Seeding the demo venues", "pnpm --filter backend run demo:portal");
  console.log(
    "\n▸ Starting the API and the Portal. Both keep running until you stop them (Ctrl+C).\n",
  );
  execSync("pnpm run dev", { cwd: ROOT, stdio: "inherit" });
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
