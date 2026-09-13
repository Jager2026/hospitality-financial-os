import { afterEach, describe, expect, it, vi } from "vitest";
import { PermanentRejection } from "../common/errors/permanent-rejection";
import { EMAIL_FROM, EmailSendError, EmailService } from "./email.service";

/**
 * ADR-069 — the Resend transport.
 *
 * **No network call is made anywhere in this file.** `fetch` is replaced, and the assertions are
 * about what this service would put on the wire. The Founder's boundary for this change was that
 * no email is sent for real without an explicit call; a test suite that hit Resend would violate
 * that on every run, and would also make the suite depend on a third party being up.
 */

const API_KEY = "re_ExampleId_ThisIsNotARealResendKey0123";

function serviceWithFetch(impl: typeof fetch) {
  vi.stubGlobal("fetch", impl);
  const logged: unknown[] = [];
  const logger = {
    setContext: () => undefined,
    info: (obj: unknown) => logged.push(obj),
    warn: () => undefined,
    error: () => undefined,
  };
  // NODE_ENV=production, because the transport refuses to touch the network anywhere else and
  // this file is precisely about what it would put on the wire. fetch is stubbed, so nothing
  // leaves the process.
  const config = {
    getOrThrow: (key: string) => (key === "NODE_ENV" ? "production" : API_KEY),
  };
  const service = new EmailService(
    config as unknown as ConstructorParameters<typeof EmailService>[0],
    logger as unknown as ConstructorParameters<typeof EmailService>[1],
  );
  return { service, logged };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("EmailService — the Resend transport (ADR-069)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it(
    "sends the documented request: bearer key, the verified sender, and the Idempotency-Key " +
      "header — the header is what makes a double dispatch produce one email, so its absence " +
      "must fail a test rather than be noticed in an inbox",
    async () => {
      let seen: { url: string; init: RequestInit } | null = null;
      const { service } = serviceWithFetch((async (url: string, init: RequestInit) => {
        seen = { url, init };
        return jsonResponse(200, { id: "msg_123" });
      }) as unknown as typeof fetch);

      const result = await service.send({
        to: "someone@example.invalid",
        subject: "Subject",
        text: "Body",
        idempotencyKey: "outbox-event-id",
      });

      expect(result.providerMessageId).toBe("msg_123");
      const call = seen as unknown as { url: string; init: RequestInit };
      expect(call.url).toBe("https://api.resend.com/emails");
      const headers = call.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
      expect(headers["Idempotency-Key"]).toBe("outbox-event-id");
      const body = JSON.parse(call.init.body as string) as Record<string, string>;
      expect(body.from).toBe(EMAIL_FROM);
      expect(body.from).toBe("noreply@plaintabs.com");
      expect(body.to).toBe("someone@example.invalid");
    },
  );

  it("keeps the provider's own words on a rejection — a record saying only 'failed' cannot be acted on", async () => {
    const { service } = serviceWithFetch((async () =>
      jsonResponse(422, { message: "domain is not verified" })) as unknown as typeof fetch);

    await expect(
      service.send({ to: "a@b.invalid", subject: "s", text: "t", idempotencyKey: "k" }),
    ).rejects.toThrow(/422.*domain is not verified/s);
  });

  it(
    "treats a 200 without a message id as a failure — an accepted send we cannot record or later " +
      "correlate a webhook against is not a success we can honestly claim",
    async () => {
      const { service } = serviceWithFetch((async () =>
        jsonResponse(200, { ok: true })) as unknown as typeof fetch);

      await expect(
        service.send({ to: "a@b.invalid", subject: "s", text: "t", idempotencyKey: "k" }),
      ).rejects.toBeInstanceOf(EmailSendError);
    },
  );

  it("turns a network failure into EmailSendError rather than letting it escape as something else", async () => {
    const { service } = serviceWithFetch((async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch);

    await expect(
      service.send({ to: "a@b.invalid", subject: "s", text: "t", idempotencyKey: "k" }),
    ).rejects.toThrow(/failed before a response.*ECONNREFUSED/s);
  });

  it(
    "never logs the message body — it carries an invitation link, which is a credential, and " +
      "CLAUDE.md puts tokens on the never-log list",
    async () => {
      const { service, logged } = serviceWithFetch((async () =>
        jsonResponse(200, { id: "msg_1" })) as unknown as typeof fetch);

      await service.send({
        to: "a@b.invalid",
        subject: "You are invited",
        text: "https://app.example/accept?token=SUPERSECRETTOKENVALUE",
        idempotencyKey: "k",
      });

      const serialised = JSON.stringify(logged);
      expect(serialised).not.toContain("SUPERSECRETTOKENVALUE");
      // The discriminating half: something WAS logged, so the assertion above is not passing
      // simply because nothing is ever recorded.
      expect(serialised).toContain("a@b.invalid");
    },
  );

  it(
    "refuses to touch the network outside production, and says so — a silent no-op would write " +
      "SENT into an audit record for a message nobody was handed",
    async () => {
      let called = false;
      vi.stubGlobal("fetch", (async () => {
        called = true;
        return jsonResponse(200, { id: "msg_1" });
      }) as unknown as typeof fetch);
      const logger = {
        setContext: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      };
      const service = new EmailService(
        {
          getOrThrow: (key: string) => (key === "NODE_ENV" ? "test" : API_KEY),
        } as unknown as ConstructorParameters<typeof EmailService>[0],
        logger as unknown as ConstructorParameters<typeof EmailService>[1],
      );

      await expect(
        service.send({ to: "a@b.invalid", subject: "s", text: "t", idempotencyKey: "k" }),
      ).rejects.toThrow(/Refusing to send outside production/);
      // The discriminating half: nothing reached the wire. An implementation that logged a warning
      // and sent anyway would satisfy nothing above and fail here.
      expect(called).toBe(false);
    },
  );

  // ── ADR-087: which KIND of failure this was, which is the whole question ─────────────────────
  //
  // The two tests below are one discriminating pair. Both describe a send that did not happen;
  // they differ only in WHY, and the answer about the alert channel differs with them. An
  // implementation that threw the same error type for both — which is what this code did until
  // ADR-087 — passes each test's first assertion and fails its second.

  it(
    "classifies the refusal as an EXPECTED rejection: concluded, recorded, and not an incident — " +
      "this is the system doing what it was built to do, and nobody is woken for it",
    async () => {
      vi.stubGlobal("fetch", (async () =>
        jsonResponse(200, { id: "msg_1" })) as unknown as typeof fetch);
      const logger = {
        setContext: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      };
      const service = new EmailService(
        {
          getOrThrow: (key: string) => (key === "NODE_ENV" ? "test" : API_KEY),
        } as unknown as ConstructorParameters<typeof EmailService>[0],
        logger as unknown as ConstructorParameters<typeof EmailService>[1],
      );

      const err = await service
        .send({ to: "a@b.invalid", subject: "s", text: "t", idempotencyKey: "k" })
        .then(() => null)
        .catch((e: unknown) => e);

      expect(err, "the refusal is a rejection: it can never succeed from here").toBeInstanceOf(
        PermanentRejection,
      );
      expect(
        (err as PermanentRejection).isIncident,
        "a policy refusal was classified as an incident — this is the line that fills an alert channel with expected behaviour",
      ).toBe(false);
      expect(
        err,
        "the refusal still wore the provider's error type, which is what made it indistinguishable from an outage",
      ).not.toBeInstanceOf(EmailSendError);
    },
  );

  it(
    "a provider rejection is NOT a PermanentRejection — Resend saying no today says nothing about " +
      "tomorrow, so it stays transient and keeps reaching the alert channel at the threshold",
    async () => {
      const { service } = serviceWithFetch((async () =>
        jsonResponse(500, { message: "Internal Server Error" })) as unknown as typeof fetch);

      const err = await service
        .send({ to: "a@b.invalid", subject: "s", text: "t", idempotencyKey: "k" })
        .then(() => null)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(EmailSendError);
      expect(
        err,
        "a provider failure was classified as permanent, which would conclude the event and drop a real send",
      ).not.toBeInstanceOf(PermanentRejection);
    },
  );
});
