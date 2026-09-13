/**
 * Thrown by a queue handler to say: **this row can never succeed, and nothing is lost by
 * concluding it.**
 *
 * Both of this system's queues — `OutboxPollerService` and `PaymentReconciliationService` — select
 * oldest-first, take a bounded batch, and had exactly one way for a row to leave: success.
 * Everything else was retried forever. A row that can never succeed therefore occupied a batch slot
 * permanently, and the queue had no vocabulary for saying so (ADR-085).
 *
 * This is that vocabulary, and it is deliberately narrow.
 *
 * ## Two independent questions, and this class answers both
 *
 * **1. Conclude, or keep retrying?** (ADR-085.) The test is: *would concluding this row lose work
 * that actually happened?* If yes, it is not a rejection, however permanent it looks.
 *
 * - A payload with no valid `journalEntryId` refers to no JournalEntry at all. There is no Wallet
 *   behind it to leave wrong, because there is no money behind it. **Rejection.**
 * - A Stripe PaymentIntent that does not exist on the connected account will not come into being.
 *   **Rejection.**
 * - `WalletProjectionService.recomputeBalance` throwing on a Membership with LedgerLine rows in two
 *   currencies is *also* permanent — it will throw identically on every retry. But the money is
 *   real and the Wallet is wrong, and abandoning it would make the system quietly wrong instead of
 *   loudly stuck. **Not a rejection.** It keeps today's behaviour: retried forever, alerted at five.
 *
 * **2. Should a person be told?** (ADR-087, and it is a different question.) *Permanent* and
 * *worth waking someone for* are unrelated properties, and conflating them is what put expected
 * behaviour into an incident channel:
 *
 * - A malformed payload reaching the outbox **is** an incident. `LedgerService` writes
 *   `journalEntryId` in the same transaction that creates the entry it names, so the product cannot
 *   produce one — if one exists, something upstream is wrong and somebody should look.
 * - `EmailService` refusing to send outside production **is not**. It is this system doing exactly
 *   what it was designed to do, announced as an emergency.
 *
 * ## Why the default is "incident" and ADR-085's default is "retry"
 *
 * The two defaults point in opposite directions and that is deliberate — both err toward not losing
 * information. A cause nobody classified should keep being retried rather than be silently dropped,
 * **and** it should reach a person rather than vanish. So a plain `new PermanentRejection(...)` is
 * an incident, and expectedness has to be claimed explicitly, at a throw site whose author knows
 * why the row can never succeed.
 *
 * ## Where it may be thrown
 *
 * Only where the code can *see* why — payload validation, a policy refusal, or a client translating
 * a provider's own "this does not exist" into our vocabulary. Never in a catch-all: a network
 * timeout, a database deadlock and a provider outage are all transient by default, and the default
 * has to be transient, because misclassifying a transient failure as a rejection discards real work.
 */
export class PermanentRejection extends Error {
  /**
   * Whether concluding this row is something a person should be told about.
   *
   * Read at the alert site, never re-derived there — the place that observes a failure cannot know
   * why it happened, and a classification made from the outcome is the conflation this exists to
   * end.
   */
  readonly isIncident: boolean;

  constructor(message: string, options: { isIncident?: boolean } = {}) {
    super(message);
    this.name = "PermanentRejection";
    this.isIncident = options.isIncident ?? true;
  }

  /**
   * A rejection that is **expected**: the system behaved exactly as designed, the row is concluded
   * and recorded, and nobody is woken.
   *
   * Use it only where the refusal is this system's own decision — a policy, a configured
   * suppression, a deliberate refusal to act. Never for an outcome that merely *looks* routine: a
   * provider returning 500 on every attempt is monotonous, not expected.
   */
  static expected(message: string): PermanentRejection {
    return new PermanentRejection(message, { isIncident: false });
  }
}
