import { execSync } from "node:child_process";
import { Client } from "pg";

/**
 * Creates and migrates the e2e database BEFORE Playwright starts anything.
 *
 * This deliberately does not live in `globalSetup`: Playwright launches `webServer` first and
 * runs `globalSetup` afterwards, so a backend that needs its database at boot fails before the
 * setup hook is ever reached. Found by running it — the first attempt put this in `globalSetup`
 * and the backend died on `PrismaClientInitializationError: Database ... does not exist` with no
 * setup output in the log at all.
 *
 * `prisma migrate deploy` also does not create a database, unlike `migrate dev` — it expects one.
 * Hence the explicit CREATE below.
 */
const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://hospitality:hospitality@localhost:5432/hospitality_os_e2e";

async function ensureDatabase(): Promise<void> {
  const url = new URL(E2E_DATABASE_URL);
  const database = url.pathname.slice(1);

  // Connect to the server's default `postgres` database to issue CREATE DATABASE — you cannot
  // create a database from inside itself. Rebuilt by swapping the pathname rather than from
  // `url.origin`: `origin` is the string "null" for non-special schemes like `postgresql:`, which
  // produced a connection attempt to a host literally named "base".
  const adminUrl = new URL(E2E_DATABASE_URL);
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    console.log(`e2e: created database ${database}`);
  } catch (error) {
    // 42P04 = duplicate_database. Anything else is a real problem and must not be swallowed.
    if ((error as { code?: string }).code !== "42P04") throw error;
    console.log(`e2e: database ${database} already present`);
  } finally {
    await admin.end();
  }
}

async function main(): Promise<void> {
  await ensureDatabase();
  const env = { ...process.env, DATABASE_URL: E2E_DATABASE_URL };
  // The project's own real migration and seed commands — the same ones production runs as
  // `preDeployCommand` (railway.backend.json). A harness that builds its own schema would be
  // testing a database that exists nowhere else. The seed matters specifically: Role and
  // Permission are reference data the auth flow actually reads.
  execSync("pnpm --filter backend run prisma:migrate:deploy", {
    cwd: "../..",
    env,
    stdio: "inherit",
  });
  execSync("pnpm --filter backend run prisma:seed", { cwd: "../..", env, stdio: "inherit" });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
