import { randomUUID } from "node:crypto";
import { execute, executeAll, queryOne } from "./db";

/**
 * A Shift, and optionally one captured sale on it, written straight into the e2e database.
 *
 * **Why SQL rather than the API.** A real sale goes through `POST /payments`, which creates a
 * Stripe PaymentIntent. The Playwright harness runs the real backend against the real network, so
 * there is no seam to fake Stripe at — the backend's own suite is where that boundary is stubbed.
 * Seeding the Ledger directly is what lets a browser test assert on a figure an owner would
 * actually see.
 *
 * **The posting is balanced, and it has to be.** `ledger_line` carries a deferred constraint
 * trigger (ADR-002) that sums debits and credits per journal entry at COMMIT and raises if they
 * differ. A fixture that wrote an unbalanced pair would fail loudly here rather than quietly
 * producing a wrong dashboard — which is the trigger doing its job on us, and worth saying because
 * it means these numbers cannot be nonsense and still land.
 */

export interface SeededShift {
  shiftId: string;
  businessDate: string;
  /** The exact instant the shift was opened at, as the database stored it. A test asserts the
   * screen renders THIS moment in the reader is own clock — comparing against a literal like
   * "16:00" would be asserting the machine is timezone, which is how a naive first version of
   * the dashboard test failed against a correct screen. */
  openedAtIso: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** An OPEN shift with no sales on it — a normal morning. */
export async function seedOpenShift(
  restaurantId: string,
  openedAtClock = "16:00",
): Promise<SeededShift> {
  const shiftId = randomUUID();
  const businessDate = today();

  // The instant is built HERE and written as a parameter, rather than assembled in SQL and read
  // back. `shift.opened_at` is a timestamp WITHOUT time zone, and node-postgres and Prisma do not
  // agree about how to interpret one: pg parses it as local wall-clock, Prisma serialises it as
  // UTC. A fixture that wrote "16:00" in SQL and read it back through pg produced an expectation
  // three hours from what the screen — fed by Prisma — correctly displayed. Owning the instant on
  // one side removes the disagreement instead of compensating for it.
  const openedAtIso = `${businessDate}T${openedAtClock}:00.000Z`;

  await execute(
    `INSERT INTO shift (id, restaurant_id, opened_at, business_date, created_at, updated_at)
     VALUES ($1, $2, $3, $4::date, NOW(), NOW())`,
    [shiftId, restaurantId, openedAtIso, businessDate],
  );
  return { shiftId, businessDate, openedAtIso };
}

/**
 * One captured sale on a shift: a bill split between the restaurant's payable and the platform
 * fee, plus the processor clearing line that balances it.
 *
 * `billMinorUnits` is what the Dashboard's "Shift revenue" must show — the sum of the two CREDIT
 * lines, which is what `BILL_REVENUE_ACCOUNTS` nets.
 */
export async function seedCapturedSale(
  restaurantId: string,
  shiftId: string,
  billMinorUnits: bigint,
  platformFeeMinorUnits: bigint,
  currency = "EUR",
): Promise<void> {
  const entryId = randomUUID();
  const restaurantShare = billMinorUnits - platformFeeMinorUnits;

  const line = (account: string, direction: "debit" | "credit", amount: bigint) => ({
    sql: `INSERT INTO ledger_line
            (id, journal_entry_id, account, direction, amount, currency, restaurant_id, shift_id, created_at)
          VALUES ($1, $2, $3::ledger_account, $4::ledger_direction, $5, $6, $7, $8, NOW())`,
    params: [
      randomUUID(),
      entryId,
      account,
      direction,
      amount.toString(),
      currency,
      restaurantId,
      shiftId,
    ],
  });

  // ONE TRANSACTION, and that is the whole point of using executeAll here. The balance trigger is
  // INITIALLY DEFERRED, so it sums debits against credits at COMMIT — writing these four
  // statements separately means four commits, and the first one fails honestly with
  // "unbalanced: debits=12000 credits=0". The trigger caught this fixture on its first run.
  //
  // The enum LABELS are lowercase in Postgres: Prisma's @map means the TypeScript name and the
  // database value differ, and raw SQL is where that stops being invisible. The first run failed
  // with "invalid input value for enum ledger_direction" for exactly that reason.
  await executeAll([
    {
      sql: `INSERT INTO journal_entry (id, entry_type, description, created_at)
            VALUES ($1, 'payment_captured', 'e2e fixture sale', NOW())`,
      params: [entryId],
    },
    line("processor_clearing", "debit", billMinorUnits),
    line("restaurant_revenue_payable", "credit", restaurantShare),
    line("platform_fee_revenue", "credit", platformFeeMinorUnits),
  ]);
}

/** Reads a Restaurant's currency, so a test asserts against the venue's own unit rather than a
 * hard-coded euro sign. */
export async function restaurantCurrency(restaurantId: string): Promise<string> {
  const row = await queryOne<{ currency: string }>(
    "SELECT currency FROM restaurant WHERE id = $1",
    [restaurantId],
  );
  if (!row) throw new Error(`no restaurant ${restaurantId} in the e2e database`);
  return row.currency;
}

/**
 * A completed Transaction the Transactions screen can actually read — Payment, Transaction,
 * JournalEntry and the four Ledger lines, in one commit.
 *
 * **`seedCapturedSale` above is not enough for this screen, and the difference matters.** That
 * fixture writes Ledger lines only, which is all the Dashboard reads: its figures come from the
 * Ledger. `GET /transactions` reads `transaction` rows, and its `tip` comes from the
 * TIP_PAYABLE lines of the journal entry attached to that transaction — so a fixture that seeds
 * one without the other produces a Dashboard showing revenue beside a Transactions screen showing
 * nothing, which is a state the product cannot reach.
 *
 * One commit, for the reason `seedCapturedSale` records: the balance trigger is INITIALLY
 * DEFERRED and sums debits against credits at COMMIT.
 */
export async function seedTransaction(options: {
  restaurantId: string;
  shiftId: string;
  billMinorUnits: bigint;
  tipMinorUnits: bigint;
  platformFeeMinorUnits: bigint;
  waiterMembershipId?: string;
  status?: "completed" | "partially_refunded" | "refunded" | "disputed";
  createdAt?: Date;
  currency?: string;
}): Promise<string> {
  const {
    restaurantId,
    shiftId,
    billMinorUnits,
    tipMinorUnits,
    platformFeeMinorUnits,
    waiterMembershipId,
    status = "completed",
    createdAt = new Date(),
    currency = "EUR",
  } = options;

  const paymentId = randomUUID();
  const transactionId = randomUUID();
  const entryId = randomUUID();
  const idempotencyKey = `e2e-${randomUUID()}`;
  const charged = billMinorUnits + tipMinorUnits;
  const restaurantShare = billMinorUnits - platformFeeMinorUnits;
  const at = createdAt.toISOString();

  const line = (account: string, direction: "debit" | "credit", amount: bigint) => ({
    sql: `INSERT INTO ledger_line
            (id, journal_entry_id, account, direction, amount, currency, restaurant_id, shift_id, created_at)
          VALUES ($1, $2, $3::ledger_account, $4::ledger_direction, $5, $6, $7, $8, $9)`,
    params: [
      randomUUID(),
      entryId,
      account,
      direction,
      amount.toString(),
      currency,
      restaurantId,
      shiftId,
      at,
    ],
  });

  await executeAll([
    {
      sql: `INSERT INTO idempotency_keys (key, endpoint_scope, request_fingerprint, status, created_at, expires_at)
            VALUES ($1, 'POST /payments', 'e2e-fixture', 'completed'::idempotency_key_status, $2, $3)`,
      params: [idempotencyKey, at, new Date(Date.now() + 86400000).toISOString()],
    },
    {
      sql: `INSERT INTO payment
              (id, restaurant_id, processor, processor_payment_id, amount, tip_amount,
               waiter_membership_id, currency, status, payment_method, idempotency_key,
               created_at, updated_at)
            VALUES ($1, $2, 'stripe', $3, $4, $5, $6, $7, 'succeeded'::payment_status, 'card', $8, $9, $9)`,
      params: [
        paymentId,
        restaurantId,
        `pi_e2e_${paymentId.slice(0, 12)}`,
        charged.toString(),
        tipMinorUnits.toString(),
        waiterMembershipId ?? null,
        currency,
        idempotencyKey,
        at,
      ],
    },
    {
      sql: `INSERT INTO transaction (id, payment_id, restaurant_id, gross_amount, currency, status, created_at)
            VALUES ($1, $2, $3, $4, $5, $6::transaction_status, $7)`,
      params: [transactionId, paymentId, restaurantId, charged.toString(), currency, status, at],
    },
    {
      sql: `INSERT INTO journal_entry (id, entry_type, transaction_id, description, created_at)
            VALUES ($1, 'payment_captured', $2, 'e2e fixture transaction', $3)`,
      params: [entryId, transactionId, at],
    },
    line("processor_clearing", "debit", charged),
    line("restaurant_revenue_payable", "credit", restaurantShare),
    line("platform_fee_revenue", "credit", platformFeeMinorUnits),
    line("tip_payable", "credit", tipMinorUnits),
  ]);

  return transactionId;
}
