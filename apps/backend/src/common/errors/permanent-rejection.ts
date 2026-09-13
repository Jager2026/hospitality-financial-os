/**
 * Thrown by a queue handler to say: **this row can never succeed, and nothing is lost by
 * concluding it.**
 *
 * Both of this system's queues — `OutboxPollerService` and `PaymentReconciliationService` — select
 * oldest-first, take a bounded batch, and have exactly one exit: success. Everything else is
 * retried forever. A row that can never succeed therefore occupies a batch slot permanently, and
 * the queue has no vocabulary for saying so (ADR-085).
 *
 * This is that vocabulary, and it is deliberately narrow.
 *
 * ## The test for whether something is a rejection
 *
 * **Would concluding this row lose work that actually happened?** If yes, it is not a rejection,
 * however permanent it looks.
 *
 * - A payload with no valid `journalEntryId` refers to no JournalEntry at all. There is no Wallet
 *   behind it to leave wrong, because there is no money behind it. **Rejection.**
 * - A Stripe PaymentIntent that does not exist on the connected account will not come into being.
 *   **Rejection.**
 * - `WalletProjectionService.recomputeBalance` throwing on a Membership with LedgerLine rows in two
 *   currencies is *also* permanent — it will throw identically on every retry until someone
 *   changes the schema. But the money is real and the Wallet is wrong, and abandoning it would
 *   make the system quietly wrong instead of loudly stuck. **Not a rejection.** It keeps today's
 *   behaviour: retried forever, alerted at five attempts.
 *
 * That third case is the reason this class exists rather than a generic `isPermanent` flag on the
 * error. "Permanent" and "safe to conclude" are different properties, and the outbox's own comment
 * has said since ADR-075 that giving up on money has never been decided. It still has not been.
 *
 * ## Where it may be thrown
 *
 * Only where the code can *see* that the input is invalid — payload validation, or a client
 * translating a provider's own "this does not exist" into our vocabulary. Never in a catch-all:
 * a network timeout, a database deadlock and a provider outage are all transient by default, and
 * the default has to be transient, because misclassifying a transient failure as a rejection
 * discards real work.
 */
export class PermanentRejection extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentRejection";
  }
}
