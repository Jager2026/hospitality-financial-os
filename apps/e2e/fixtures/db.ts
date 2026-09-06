import { Client } from "pg";
import { E2E_DATABASE_URL } from "../playwright.config";

/**
 * A direct read of the e2e database, used for exactly one purpose: asserting what the application
 * actually **stored**, rather than what it reports back.
 *
 * Everything else in this harness goes through real HTTP on purpose. This does not, and the
 * distinction is deliberate — "the login endpoint accepts the right password and rejects the
 * wrong one" is satisfied by an implementation that stores passwords in plain text, so proving
 * that hashing really happened needs a look at the row itself. A test that cannot see the storage
 * cannot tell hashing from comparison.
 *
 * Raw SQL rather than Prisma: the generated client belongs to the backend package, and importing
 * it here would mean this harness depends on the backend's build output rather than on its
 * running HTTP surface. One small query is a smaller commitment than that.
 */
export async function queryOne<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows[0] as T | undefined;
  } finally {
    await client.end();
  }
}

/**
 * A write, permitted only under the narrow rule in `org.ts`: **the entity being created is not the
 * subject of the check.** Anything the assertion is actually about goes through its real endpoint.
 */
export async function execute(sql: string, params: unknown[] = []): Promise<void> {
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query(sql, params);
  } finally {
    await client.end();
  }
}

/**
 * Several writes inside ONE transaction.
 *
 * **Why this exists rather than calling `execute` three times.** `execute` opens its own
 * connection and commits on its own, so three calls are three transactions. That is invisible until
 * a constraint is DEFERRED — and `ledger_line`'s balance trigger is (ADR-002): it sums debits and
 * credits per journal entry **at COMMIT**. Seeding a posting one statement at a time therefore
 * fails on the first line, correctly, because at that moment the entry really is unbalanced.
 *
 * The trigger caught the fixture rather than the fixture working around the trigger, which is the
 * right way round and is why this helper is narrow: it makes a balanced posting expressible, not
 * an unbalanced one possible.
 */
export async function executeAll(statements: { sql: string; params?: unknown[] }[]): Promise<void> {
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const statement of statements) {
      await client.query(statement.sql, statement.params ?? []);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
