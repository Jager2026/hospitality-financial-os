import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password.util";
import { executeRedaction, planRedaction } from "./redact-user";

/**
 * ADR-052 claims that an erasure empties the person. This asks the database whether that is true,
 * and it asks about the WHOLE database rather than about a list of tables.
 *
 * **Why not simply add the two missed tables to the erasure and move on.** They would not have
 * been the last. `EmailDelivery` and `OutboxEvent` were missed for an entire block, and the check
 * that was supposed to notice — `repo-invariants.spec.ts`, "classifies every String field on User"
 * — could not, by construction: it parses `model User { … }` and nothing else, so a column on a
 * *different* table holding the same person's address is outside the question it asks. The gap was
 * not that the list was short. It was that the mechanism's shape was one model wide and the
 * problem is schema wide.
 *
 * **So this enumerates the columns from `information_schema` rather than from a constant.** A new
 * table that stores a person's address is covered the day it is created, by nobody remembering
 * anything. There is no list to fall behind and no allowlist to edit green.
 *
 * **What it costs, stated rather than discovered later:** it reads every text-ish and JSON column
 * in the schema once, which on a development database is a second or two and grows with the data.
 * If it ever becomes slow the answer is to narrow the ROWS (the erased user's own), not the
 * columns — narrowing the columns would reintroduce exactly the blindness it exists to remove.
 */
describe("erasure leaves nothing (ADR-052, schema-wide)", () => {
  const prisma = new PrismaClient();

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Every column that could hold an address, discovered rather than listed. */
  async function textishColumns(): Promise<{ table: string; column: string }[]> {
    return prisma.$queryRaw<{ table: string; column: string }[]>`
      SELECT c.table_name AS "table", c.column_name AS "column"
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public'
        AND t.table_type = 'BASE TABLE'
        AND c.data_type IN ('text', 'character varying', 'character', 'json', 'jsonb')
      ORDER BY c.table_name, c.column_name
    `;
  }

  async function occurrences(email: string): Promise<string[]> {
    const found: string[] = [];
    for (const { table, column } of await textishColumns()) {
      const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM "${table}" WHERE "${column}"::text LIKE $1`,
        `%${email}%`,
      );
      const n = Number(rows[0]?.n ?? 0n);
      if (n > 0) found.push(`${table}.${column} (${n} row${n === 1 ? "" : "s"})`);
    }
    return found;
  }

  it("finds the address before the erasure and nowhere after it", async () => {
    const email = `erasure-sweep-${Date.now()}@example.test`;

    const user = await prisma.user.create({
      data: {
        email,
        displayName: "Erasure Sweep",
        passwordHash: await hashPassword("SweepPassword!2026"),
        locale: "en",
      },
    });

    // The two surfaces this test exists for. Both hold the address outside `User`, and both were
    // missed by a check that only ever looked at `User`.
    const event = await prisma.outboxEvent.create({
      data: {
        aggregateType: "MembershipInvitation",
        aggregateId: user.id,
        eventType: "email.send_requested",
        payload: {
          to: email,
          subject: "You have been invited",
          text: `Accept here: https://example.test/invitations/accept?token=live-token-${user.id}`,
        },
      },
    });
    await prisma.emailDelivery.create({
      data: { outboxEventId: event.id, to: email, subject: "You have been invited" },
    });

    // THE CASE THAT MUST PASS BEFORE THE ONE THAT MUST FAIL. A sweep that found nothing would
    // report a perfect erasure of an address that was never stored — the vacuous green this
    // project has been bitten by more than once.
    const before = await occurrences(email);
    expect(
      before.length,
      "the sweep found the address nowhere BEFORE the erasure, so it proves nothing after it",
    ).toBeGreaterThanOrEqual(3);
    expect(before.some((f) => f.startsWith("outbox_event."))).toBe(true);
    expect(before.some((f) => f.startsWith("email_delivery."))).toBe(true);

    const plan = await planRedaction(prisma, email);
    await executeRedaction(prisma, plan, { clearRequestMetadata: true });

    const after = await occurrences(email);
    expect(
      after,
      `ADR-052 says an erasure empties the person. The address survives in:\n${after.join("\n")}`,
    ).toEqual([]);
  }, 60_000);
});
