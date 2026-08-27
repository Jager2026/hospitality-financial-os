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
