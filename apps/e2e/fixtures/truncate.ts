import { Client } from "pg";

/**
 * ADR-082: the e2e database is emptied **before** each run, not after.
 *
 * `playwright.config.ts` has always said the separate database exists "so a run can truncate
 * freely". Until this module it never did, and the comment described an intention rather than a
 * mechanism — accumulated rows were then diagnosed four separate times (#177, #180, #185, #194),
 * each answered with "run `db:reset`", which treats the case and leaves the property.
 *
 * **Before, not after, and the reason is evidence rather than tidiness.** The rows a failed run
 * left behind are where its cause is still visible — the database is a third place to look,
 * alongside the log and the trace. A teardown destroys exactly the run that was worth reading.
 * It is also the weaker of the two: a teardown does not execute when a run is killed, crashes, or
 * is interrupted, which are precisely the runs whose residue confuses somebody later. Cleaning up
 * afterwards would tidy the runs that were already tidy.
 *
 * The price is accepted explicitly: nothing bounds growth *within* a run, so the ~528 rows one run
 * produces stay on disk until the next run starts and removes them.
 *
 * ── Why the list is derived and not written down ───────────────────────────────────────────────
 *
 * The tables come from `information_schema`, never from an array of names. A written list is a
 * list somebody edits to make a red run green, and this repository has watched that happen twice
 * — `test/global-setup.ts`'s permission matrix, and ADR-058's allow list. A derived list has no
 * handle to loosen, and a table added by next sprint's migration joins the sweep by existing
 * rather than by being remembered.
 *
 * ── What survives, and why it is not the reference data ────────────────────────────────────────
 *
 * Only `_prisma_migrations`. It is not data; it is the record of which migrations have been
 * applied, and truncating it makes `prisma migrate deploy` try to create tables that already
 * exist, so the next run fails at its first step.
 *
 * The reference data — `currency`, `permission`, `role`, `role_permission` — is deliberately NOT
 * preserved, because preserving it would mean naming it, which is the written list again.
 * `prisma/seed.ts` is its complete producer: it writes those four tables with `upsert` and
 * reconciles them by deleting `role_permission` rows that should not exist, so it drives them to a
 * declared state from whatever it finds, including nothing. `db:prepare` runs it immediately
 * after this sweep. Verified rather than reasoned: truncating all 24 tables and re-preparing
 * returned exactly the 58 reference rows that were there before.
 */
export const MIGRATION_BOOKKEEPING = "_prisma_migrations";

/**
 * The tables this sweep would empty, read from the catalogue at the moment it is called.
 *
 * Separate from the truncation itself so a test can assert *what* would be swept without
 * emptying a database to find out.
 */
export async function tablesToTruncate(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name <> $1
      ORDER BY table_name`,
    [MIGRATION_BOOKKEEPING],
  );
  return rows.map((row) => row.table_name);
}

/**
 * Empties every table in the public schema except the migration bookkeeping.
 *
 * One statement for all of them: `TRUNCATE a, b, c` resolves foreign keys between the listed
 * tables, where truncating them one at a time would fail on the first reference. `CASCADE` covers
 * anything referencing a listed table from outside the list, and `RESTART IDENTITY` resets
 * sequences so a fresh run does not inherit the previous run's id counters.
 *
 * @returns the tables that were emptied, for the caller to report.
 */
export async function truncateTestResidue(connectionString: string): Promise<string[]> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const tables = await tablesToTruncate(client);
    // A database that has just been created has no tables yet; `migrate deploy` has run by the
    // time this is called in `db:prepare`, but the guard keeps this function honest on its own.
    if (tables.length === 0) return [];

    // Identifiers come from the catalogue, so they are real table names rather than input — the
    // doubling is here because building SQL by concatenation is the habit worth not having, not
    // because a table in this schema could be called `foo"bar`.
    const quoted = tables.map((name) => `"${name.replace(/"/g, '""')}"`).join(", ");
    await client.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
    return tables;
  } finally {
    await client.end();
  }
}
