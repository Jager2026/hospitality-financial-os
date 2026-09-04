import { Injectable } from "@nestjs/common";
import type { OutboxEvent, Prisma } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { PrismaService } from "../prisma/prisma.service";
import { EmailSendError, EmailService } from "./email.service";

/**
 * ADR-069 — email as an Outbox consumer: the request half and the dispatch half.
 *
 * **Why the Outbox and not a direct call.** A direct `await email.send(...)` inside a request
 * handler loses the message on any crash between deciding to send and sending, and it makes the
 * caller's transaction depend on a third party being reachable. Writing the intent in the same
 * transaction as the business fact means the send survives a restart and cannot happen for a
 * transaction that rolled back.
 *
 * **This is the second Outbox consumer, and the project wrote down in advance what that means.**
 * `IMPLEMENTATION_PLAN.md` (Deferred) says the poller has no claim step, that a second backend
 * instance and a second consumer are the two triggers, and that *"the second is the one to defend
 * against, precisely because it does not announce itself — it arrives through ordinary feature
 * work."* It has now arrived, and it is announced here rather than discovered later.
 *
 * **Two independent defences, because the claim step is still missing.** A double dispatch is
 * stopped first by the UNIQUE constraint on `EmailDelivery.outboxEventId` (the second dispatcher
 * fails at the database, not at the recipient), and second by Resend's own `Idempotency-Key`,
 * keyed on the OutboxEvent id. **Neither is a substitute for the claim step**, which remains
 * missing for whatever consumer comes third.
 */

export const EMAIL_OUTBOX_EVENT_TYPE = "email.send_requested";
export const EMAIL_OUTBOX_AGGREGATE_TYPE = "EmailDelivery";

/** What an email request carries. The BODY IS HERE, which is the uncomfortable part and is stated
 * rather than hidden: the Outbox must persist what is to be sent, so anything in `text` is at rest
 * for as long as the payload is. `redactPayload` below bounds that to the delivery window. ADR-069
 * records the consequence for the invitation token specifically, which is a decision for the
 * change that introduces it, not this one. */
interface EmailPayload {
  to: string;
  subject: string;
  text: string;
}

@Injectable()
export class EmailOutboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(EmailOutboxService.name);
  }

  /**
   * Records an email to be sent, inside the caller's own transaction.
   *
   * **Takes a transaction client rather than opening one.** The whole value of the Outbox is that
   * the intent to send commits or rolls back with the business fact that caused it; a method that
   * started its own transaction would break exactly that and look identical from the call site.
   */
  async enqueue(tx: Prisma.TransactionClient, payload: EmailPayload): Promise<string> {
    const event = await tx.outboxEvent.create({
      data: {
        aggregateType: EMAIL_OUTBOX_AGGREGATE_TYPE,
        // A placeholder until the delivery row exists — rewritten immediately below, in the same
        // transaction, so no reader ever observes the intermediate value.
        aggregateId: "00000000-0000-0000-0000-000000000000",
        eventType: EMAIL_OUTBOX_EVENT_TYPE,
        payload: { ...payload },
      },
    });

    const delivery = await tx.emailDelivery.create({
      data: { outboxEventId: event.id, to: payload.to, subject: payload.subject },
    });

    await tx.outboxEvent.update({
      where: { id: event.id },
      data: { aggregateId: delivery.id },
    });

    return delivery.id;
  }

  /**
   * Sends one requested email. Called by `OutboxPollerService` for `email.send_requested` events.
   *
   * **Marking published and recording the outcome are one transaction**, the same discipline the
   * Wallet path already uses — but the send itself is deliberately OUTSIDE it. Holding a database
   * transaction open across a call to a third party is how a slow provider becomes a connection
   * pool outage; and a crash after the send but before the commit is covered by the idempotency
   * key on the retry, which is what that key is for.
   */
  async handle(event: OutboxEvent): Promise<void> {
    const payload = event.payload as Partial<EmailPayload>;
    if (
      typeof payload.to !== "string" ||
      typeof payload.subject !== "string" ||
      typeof payload.text !== "string"
    ) {
      throw new Error(`OutboxEvent ${event.id} is not a well-formed email request`);
    }
    // Copied into locals rather than read through `payload` below: the typeof guards above narrow
    // the property types only until the first await, after which TypeScript must assume a mutable
    // object could have changed. Locals keep the narrowing honest instead of asserting it away.
    const { to, subject, text } = payload as EmailPayload;

    const delivery = await this.prisma.emailDelivery.findUnique({
      where: { outboxEventId: event.id },
    });
    if (!delivery) {
      // enqueue() writes both rows in one transaction, so this means someone produced an email
      // event by another route. Failing is right: sending without an audit record is the thing
      // this design exists to prevent.
      throw new Error(`OutboxEvent ${event.id} has no EmailDelivery record — refusing to send`);
    }
    if (delivery.status === "SENT") {
      // A second dispatcher reaching an already-sent row. Nothing to do, and saying so is not the
      // same as pretending it never happened.
      this.logger.warn(
        { eventId: event.id, deliveryId: delivery.id },
        "Email already sent for this Outbox event — skipping (double dispatch, no claim step)",
      );
      return;
    }

    try {
      const { providerMessageId } = await this.email.send({
        to,
        subject,
        text,
        // The OutboxEvent id, which is stable across every retry of this same send and different
        // for every other. Resend's key expires after 24 hours; ADR-069 states what that bounds.
        idempotencyKey: event.id,
      });

      await this.prisma.$transaction(async (tx) => {
        await tx.emailDelivery.update({
          where: { id: delivery.id },
          data: { status: "SENT", providerMessageId, lastError: null },
        });
        await tx.outboxEvent.update({
          where: { id: event.id },
          data: {
            publishedAt: new Date(),
            payload: redactPayload({ to, subject }),
          },
        });
      });
    } catch (err) {
      // THE TRACE. A failed send that leaves nothing behind is silence, and silence is
      // indistinguishable from success. The status and the provider's own words are written here,
      // then the error is rethrown so the poller's existing attempt counter and its alert at five
      // failures still fire — this records what happened, it does not swallow it.
      const message = err instanceof EmailSendError ? err.message : String(err);
      await this.prisma.emailDelivery.update({
        where: { id: delivery.id },
        data: { status: "FAILED", lastError: message.slice(0, 1000) },
      });
      throw err;
    }
  }
}

/**
 * What is left in the payload once the message has gone.
 *
 * **The body does not stay.** An email body is the one Outbox payload that can contain a secret —
 * an invitation link is a credential — and a published row is kept forever. Bounding the body to
 * the delivery window costs one field and removes a class of at-rest exposure that no later change
 * has to remember to think about.
 *
 * This makes an email event non-replayable, which for a *money* event would be wrong and here is
 * the point: replaying a send is precisely what must not happen.
 */
function redactPayload(payload: Pick<EmailPayload, "to" | "subject">): Prisma.InputJsonValue {
  return { to: payload.to, subject: payload.subject, text: "[redacted after delivery]" };
}
