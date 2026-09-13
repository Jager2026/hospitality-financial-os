import type { PrismaClient } from "@prisma/client";

export interface DatabaseLocation {
  /** `null` means a unix socket — the server is on this machine. */
  host: string | null;
  database: string;
}

/**
 * Refuses to proceed unless the connected database is on this machine or a private network.
 *
 * **It asks the database, not the connection string.** A URL can be read wrong, overridden by an
 * environment nobody remembered, or point somewhere through a tunnel; `inet_server_addr()` is the
 * server's own answer about where it is. Production is reached only through Railway's tooling, and
 * neither caller here has a way to get there — but a guard that depends on nobody making a mistake
 * is not a guard.
 *
 * **Why this is one function and not two.** It was written for `seed-portal-demo.ts`, which
 * rebuilds a demo Organization. `test/global-setup.ts` then needed the identical check for its own
 * pre-run sweep (ADR-086), and a second hand-written copy is the shape this repository has been
 * burned by twice: `test/global-setup.ts`'s own permission matrix drifted four Permissions and
 * three Roles away from the seed before anyone noticed, and ADR-011 exists because two copies of
 * one document answered the same question differently. A rule about **where it is safe to delete
 * rows** is the last thing that should exist in two versions.
 *
 * It lives in `prisma/` rather than `scripts/` for a reason that is not taste: `tsconfig.typecheck.json`
 * covers `src/`, `test/` and `prisma/` and does **not** cover `scripts/`, so a copy living there
 * would be the one file nobody's compiler looks at — the exact argument that config's own comment
 * makes about `prisma/seed.ts`.
 *
 * @param action what the caller is about to do, quoted back in the refusal so the message says why
 *               it mattered rather than only that something was refused.
 */
export async function assertLocalDatabase(
  prisma: PrismaClient,
  action: string,
): Promise<DatabaseLocation> {
  if (process.env.NODE_ENV === "production") {
    throw new Error(`NODE_ENV is production. REFUSING: ${action}.`);
  }

  const [row] = await prisma.$queryRaw<{ host: string | null; db: string }[]>`
    SELECT inet_server_addr()::text AS host, current_database() AS db
  `;
  const host = row?.host ?? null;

  // null means a unix socket — the server is on this machine. Otherwise it must be loopback or a
  // private range: 10/8, 172.16/12, 192.168/16, or IPv6 loopback.
  const local =
    host === null ||
    host.startsWith("127.") ||
    host === "::1" ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (!local) {
    throw new Error(
      `REFUSING: the database at ${host} (${row?.db}) is not on this machine or a private ` +
        `network, and ${action}.`,
    );
  }

  return { host, database: row?.db ?? "unknown" };
}
