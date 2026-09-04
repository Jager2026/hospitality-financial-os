import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { EMAIL_OUTBOX_EVENT_TYPE, EmailOutboxService } from "./email-outbox.service";
import { EmailSendError, type EmailService } from "./email.service";

/**
 * ADR-069 — email through the Outbox, against a real database.
 *
 * **The transport is a stub in every test here and no network call is made.** What is under test
 * is the plumbing: that a request and its audit record commit together, that a failure leaves a
 * trace, that a success removes the body, and that a double dispatch cannot become a double send.
 */

const NOISE = "https://app.example/accept?token=SUPERSECRETTOKENVALUE";

describe("EmailOutboxService (real database)", () => {
  const prisma = new PrismaService();

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const logger = {
    setContext: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as ConstructorParameters<typeof EmailOutboxService>[2];

  /** A transport that records what it was asked to send, and can be told to fail. */
  function stubTransport(behaviour: "ok" | "fail") {
    const calls: Array<{ to: string; idempotencyKey: string }> = [];
    const email = {
      send: async (input: { to: string; idempotencyKey: string }) => {
        calls.push({ to: input.to, idempotencyKey: input.idempotencyKey });
        if (behaviour === "fail") {
          throw new EmailSendError("Resend returned 422: domain is not verified");
        }
        return { providerMessageId: `msg_${randomUUID()}` };
      },
    } as unknown as EmailService;
    return { email, calls };
  }

  function serviceWith(behaviour: "ok" | "fail") {
    const { email, calls } = stubTransport(behaviour);
    return { service: new EmailOutboxService(prisma, email, logger), calls };
  }

  async function enqueueOne(service: EmailOutboxService, to = `${randomUUID()}@example.invalid`) {
    const deliveryId = await prisma.$transaction((tx) =>
      service.enqueue(tx, { to, subject: "You have been invited", text: NOISE }),
    );
    const delivery = await prisma.emailDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
    const event = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: delivery.outboxEventId },
    });
    return { delivery, event };
  }

  it(
    "records the request and its audit row together, unpublished and PENDING — the record exists " +
      "BEFORE anything is attempted, which is what makes a disclosure event auditable at all",
    async () => {
      const { service } = serviceWith("ok");
      const { delivery, event } = await enqueueOne(service);

      expect(event.eventType).toBe(EMAIL_OUTBOX_EVENT_TYPE);
      expect(event.publishedAt).toBeNull();
      expect(delivery.status).toBe("PENDING");
      expect(delivery.providerMessageId).toBeNull();
      // The event points at the delivery row, so an operator holding either can find the other.
      expect(event.aggregateId).toBe(delivery.id);
    },
  );

  it(
    "commits with the CALLER's transaction, not its own — a rolled-back caller must leave no " +
      "request and no audit row, or the Outbox would promise to send for work that never happened",
    async () => {
      const { service } = serviceWith("ok");
      const to = `${randomUUID()}@example.invalid`;

      await expect(
        prisma.$transaction(async (tx) => {
          await service.enqueue(tx, { to, subject: "s", text: "t" });
          throw new Error("caller rolled back");
        }),
      ).rejects.toThrow("caller rolled back");

      // The discriminating assertion: a version of enqueue() that opened its own transaction would
      // leave both rows behind here and look identical at the call site.
      expect(await prisma.emailDelivery.findFirst({ where: { to } })).toBeNull();
    },
  );

  it(
    "on success: marks SENT with the provider's id, publishes the event, and REMOVES the body — " +
      "an invitation link is a credential, and a published row is kept forever",
    async () => {
      const { service, calls } = serviceWith("ok");
      const { delivery, event } = await enqueueOne(service);
      expect(event.payload).toMatchObject({ text: NOISE });

      await service.handle(event);

      const after = await prisma.emailDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
      expect(after.status).toBe("SENT");
      expect(after.providerMessageId).toMatch(/^msg_/);
      expect(after.lastError).toBeNull();

      const publishedEvent = await prisma.outboxEvent.findUniqueOrThrow({
        where: { id: event.id },
      });
      expect(publishedEvent.publishedAt).not.toBeNull();
      expect(JSON.stringify(publishedEvent.payload)).not.toContain("SUPERSECRETTOKENVALUE");

      // The idempotency key is the OutboxEvent id — stable across retries of this send, different
      // for every other send.
      expect(calls[0].idempotencyKey).toBe(event.id);
    },
  );

  it(
    "on failure: leaves a trace naming WHAT failed and WHY, does not publish, and rethrows so the " +
      "poller's own attempt counter and its alert still fire — silence is the failure mode here",
    async () => {
      const { service } = serviceWith("fail");
      const { delivery, event } = await enqueueOne(service);

      await expect(service.handle(event)).rejects.toBeInstanceOf(EmailSendError);

      const after = await prisma.emailDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
      expect(after.status).toBe("FAILED");
      expect(after.lastError).toContain("domain is not verified");
      // Not published: the poller must try again rather than treat a failure as done.
      const stillPending = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(stillPending.publishedAt).toBeNull();
    },
  );

  it(
    "a second dispatch of the same event sends NOTHING — the poller has no claim step, so this is " +
      "the behaviour that stands between two backend instances and two emails to one person",
    async () => {
      const { service, calls } = serviceWith("ok");
      const { event } = await enqueueOne(service);

      await service.handle(event);
      expect(calls).toHaveLength(1);

      // Exactly what a second instance would do: dispatch the same row it also read as unpublished.
      await service.handle(event);
      // An implementation without the already-SENT check calls the transport twice and fails here.
      expect(calls).toHaveLength(1);
    },
  );

  it(
    "the audit row is UNIQUE per Outbox event — the database refuses a second delivery record, so " +
      "the guarantee does not rest on the in-process check above alone",
    async () => {
      const { service } = serviceWith("ok");
      const { delivery, event } = await enqueueOne(service);

      await expect(
        prisma.emailDelivery.create({
          data: { outboxEventId: event.id, to: delivery.to, subject: delivery.subject },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    },
  );

  it("refuses to send an event that has no audit record — sending without a trace is the thing this design prevents", async () => {
    const { service, calls } = serviceWith("ok");
    const orphan = await prisma.outboxEvent.create({
      data: {
        aggregateType: "EmailDelivery",
        aggregateId: randomUUID(),
        eventType: EMAIL_OUTBOX_EVENT_TYPE,
        payload: { to: "a@b.invalid", subject: "s", text: "t" },
      },
    });

    await expect(service.handle(orphan)).rejects.toThrow(/no EmailDelivery record/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a malformed email request rather than sending a half-built message", async () => {
    const { service, calls } = serviceWith("ok");
    const malformed = await prisma.outboxEvent.create({
      data: {
        aggregateType: "EmailDelivery",
        aggregateId: randomUUID(),
        eventType: EMAIL_OUTBOX_EVENT_TYPE,
        payload: { to: "a@b.invalid" },
      },
    });

    await expect(service.handle(malformed)).rejects.toThrow(/not a well-formed email request/);
    expect(calls).toHaveLength(0);
  });
});
