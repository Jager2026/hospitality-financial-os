import { Client } from "pg";
import { expect, test } from "@playwright/test";
import { E2E_DATABASE_URL } from "../playwright.config";
import { MIGRATION_BOOKKEEPING, tablesToTruncate, truncateTestResidue } from "../fixtures/truncate";

/**
 * ADR-082's sweep, falsified rather than described.
 *
 * ── Why this runs against a database of its own ────────────────────────────────────────────────
 *
 * The sweep empties every table it is pointed at. Pointed at the running suite's database it would
 * delete the rows every other test in this run is asserting on, so these tests build a throwaway
 * database, prove the mechanism there, and drop it. The one assertion that *must* look at the real
 * database — that `db:prepare` preserved the bookkeeping and restored the reference data — only
 * reads.
 *
 * ── What each test would have to be wrong for ──────────────────────────────────────────────────
 *
 * Each case names the implementation it rejects, because a test that no plausible wrong version
 * fails is decoration. The two wrong versions in question are the ones actually available: a
 * hand-written list of table names, and a sweep that forgets to exclude the migration bookkeeping.
 */

const ADMIN_URL = (() => {
  const url = new URL(E2E_DATABASE_URL);
  url.pathname = "/postgres";
  return url.toString();
})();

const THROWAWAY = "hospitality_os_e2e_sweep_check";

const THROWAWAY_URL = (() => {
  const url = new URL(E2E_DATABASE_URL);
  url.pathname = `/${THROWAWAY}`;
  return url.toString();
})();

async function withAdmin<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function withThrowaway<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: THROWAWAY_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/**
 * A database holding the bookkeeping table and one ordinary table, both with a row in them.
 * Deliberately NOT built by running the migrations: the point is that the sweep reads the
 * catalogue, so it must work on a schema it has never been told about.
 */
test.beforeEach(async () => {
  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${THROWAWAY}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${THROWAWAY}"`);
  });
  await withThrowaway(async (db) => {
    await db.query(`CREATE TABLE "${MIGRATION_BOOKKEEPING}" (id TEXT PRIMARY KEY)`);
    await db.query(`INSERT INTO "${MIGRATION_BOOKKEEPING}" (id) VALUES ('20260101_initial')`);
    await db.query("CREATE TABLE parent (id INT PRIMARY KEY)");
    await db.query("CREATE TABLE child (id INT PRIMARY KEY, parent_id INT REFERENCES parent(id))");
    await db.query("INSERT INTO parent (id) VALUES (1)");
    await db.query("INSERT INTO child (id, parent_id) VALUES (1, 1)");
  });
});

test.afterEach(async () => {
  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${THROWAWAY}" WITH (FORCE)`);
  });
});

test("the bookkeeping survives and everything else is emptied", async () => {
  const truncated = await truncateTestResidue(THROWAWAY_URL);

  expect(truncated.sort(), "the sweep did not cover the ordinary tables").toEqual([
    "child",
    "parent",
  ]);

  await withThrowaway(async (db) => {
    // THE DISCRIMINATING HALF. A sweep that forgot to exclude the bookkeeping would empty this
    // too, and nothing else in this file would notice — the suite would only fail on the NEXT
    // run, inside `prisma migrate deploy`, as "table already exists", which names the symptom in
    // a different process from the cause.
    const kept = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM "${MIGRATION_BOOKKEEPING}"`,
    );
    expect(Number(kept.rows[0].n), "the migration bookkeeping was truncated").toBe(1);

    for (const table of ["parent", "child"]) {
      const left = await db.query<{ n: string }>(`SELECT count(*) AS n FROM "${table}"`);
      expect(Number(left.rows[0].n), `${table} was not emptied`).toBe(0);
    }
  });
});

test("a table nobody listed is swept because it exists, not because it was remembered", async () => {
  // The falsification of a hand-written list, and the reason the list is derived. This table is
  // created after the sweep was written and is named in no array anywhere; a list-based
  // implementation passes every other test in this file and fails this one.
  await withThrowaway(async (db) => {
    await db.query("CREATE TABLE arrived_in_a_later_migration (id INT PRIMARY KEY)");
    await db.query("INSERT INTO arrived_in_a_later_migration (id) VALUES (1)");
  });

  const truncated = await truncateTestResidue(THROWAWAY_URL);
  expect(truncated, "a table added after the sweep was written escaped it").toContain(
    "arrived_in_a_later_migration",
  );

  await withThrowaway(async (db) => {
    const left = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM arrived_in_a_later_migration",
    );
    expect(Number(left.rows[0].n)).toBe(0);
  });
});

test("foreign keys do not decide the order, because there is only one statement", async () => {
  // `child` references `parent`. Truncating them one at a time in catalogue order would fail on
  // the first one — this passes only because every table goes into a single TRUNCATE.
  await withThrowaway(async (db) => {
    const plan = await tablesToTruncate(db);
    expect(plan, "the plan must contain both sides of the reference").toEqual(["child", "parent"]);
  });

  await expect(truncateTestResidue(THROWAWAY_URL)).resolves.toHaveLength(2);
});

test("the real run preserved its bookkeeping and got its reference data back", async () => {
  // The only assertion here that touches the suite's own database, and it only reads. It fails if
  // the sweep were placed AFTER the seed rather than before it — the reference tables would be
  // empty and every other spec would fail on a missing currency or role, reported as a product
  // fault rather than as a harness one.
  //
  // Counts are asserted as "not empty" rather than as 14/10/5/29. The exact numbers are recorded
  // in ADR-082 where they were measured; a literal here would be a second copy of the seed's own
  // matrix, which is the drift `test/global-setup.ts` already paid for once.
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    const bookkeeping = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM "${MIGRATION_BOOKKEEPING}"`,
    );
    expect(
      Number(bookkeeping.rows[0].n),
      "the run swept its own migration bookkeeping",
    ).toBeGreaterThan(0);

    for (const table of ["currency", "permission", "role", "role_permission"]) {
      const seeded = await client.query<{ n: string }>(`SELECT count(*) AS n FROM "${table}"`);
      expect(
        Number(seeded.rows[0].n),
        `${table} is empty — the sweep ran after the seed instead of before it`,
      ).toBeGreaterThan(0);
    }
  } finally {
    await client.end();
  }
});
