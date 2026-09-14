import type { PrismaService } from "../prisma/prisma.service";
import { PROCESSOR_FEE_EVENT_TYPE } from "./processor-fee.service";

/**
 * ADR-094. **Three states, because two of them are not the same fact and a reader cannot tell them
 * apart from a blank.**
 *
 * - `available` — the fee has been read from Stripe. The amount may still be `0`: "known and zero"
 *   is a real answer and must not collapse into "not known".
 * - `pending` — the fetch is still queued. The payment is recent; the number is coming.
 * - `unavailable` — it is not coming. Either the fetch was abandoned after its attempt limit, or
 *   the payment predates this mechanism and nothing will ever ask.
 *
 * The third must not look like the second on screen, which is the whole reason this returns a
 * state rather than a nullable number.
 */
export type ProcessorFeeStatus = "available" | "pending" | "unavailable";

/**
 * Derived from the two rows that actually know, rather than cached on the Transaction.
 *
 * **The claim column answers "is it known"** — it is set in the same transaction that posts the
 * entry, so it cannot be true while the entry is missing.
 *
 * **The Outbox row answers "is it still coming"**, and it is the only thing that does: the poller
 * owns the retry schedule and the abandonment, so a second copy of that state on the Transaction
 * would be a denormalisation that drifts the first time the two are written apart. One query on a
 * single-row detail endpoint is the price, and it is the right one to pay.
 */
export async function processorFeeStatus(
  prisma: PrismaService,
  transaction: { paymentId: string; processorFeeBalanceTxnId: string | null },
): Promise<ProcessorFeeStatus> {
  if (transaction.processorFeeBalanceTxnId !== null) return "available";

  const rows = await prisma.$queryRaw<Array<{ pending: boolean }>>`
    SELECT (o.published_at IS NULL AND o.abandoned_at IS NULL) AS pending
    FROM "outbox_event" o
    WHERE o.event_type = ${PROCESSOR_FEE_EVENT_TYPE}
      AND o.payload::jsonb ->> 'paymentId' = ${transaction.paymentId}
    LIMIT 1`;

  // No row at all is a payment captured before this mechanism existed: nothing will ever ask for
  // its fee, which is exactly `unavailable` — true, and deliberately not a fourth state, because
  // the reader's question is "will a number appear here?" and the answer is the same no.
  return rows[0]?.pending ? "pending" : "unavailable";
}
