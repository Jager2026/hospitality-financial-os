import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PinoLogger } from "nestjs-pino";

/**
 * ADR-069 — the Resend transport, and nothing else.
 *
 * **This class knows how to hand one message to Resend. It does not know when to send, what to
 * say, or who to tell when it fails.** Those live in the Outbox handler, in the caller, and in the
 * poller's existing alerting respectively. Keeping the transport free of policy is what lets the
 * whole email path be tested without a network, and what would let Resend be replaced without
 * touching anything that decides to send.
 *
 * **No SDK, deliberately.** The requirement is one `POST` with a bearer token, a JSON body and an
 * idempotency header. An SDK for that is a dependency in a system whose CI runs a vulnerability
 * gate on every push and whose own rules treat supply-chain surface as a cost. `fetch` is in the
 * runtime. If Resend's protocol ever grows past what fits here, that is the moment to reconsider —
 * not in advance.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * The verified sender. A constant rather than configuration, and that is the safer form here: the
 * domain is verified once at the DNS level (DKIM, SPF, MX green on plaintabs.com) and is the same
 * in every environment this system runs in. A configuration knob would add a way to get it wrong —
 * a mismatch between the configured sender and the verified domain fails at Resend, at send time,
 * silently, which is precisely the class of failure ADR-045 is about. If a second sending domain
 * ever exists, THAT is when this becomes configuration.
 */
export const EMAIL_FROM = "noreply@plaintabs.com";

/** Resend's documented limit is 10 requests per second per team; nothing here approaches that, but
 * a hung request must not hold a poller cycle open indefinitely. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  /**
   * Resend's `Idempotency-Key`. Documented: unique per request, at most 256 characters, and
   * **expiring after 24 hours** — that expiry is a real boundary, not a footnote, and ADR-069
   * records what it does and does not cover.
   */
  idempotencyKey: string;
}

export interface SendEmailResult {
  providerMessageId: string;
}

/** Thrown when Resend did not accept the message. Carries the provider's own text so the delivery
 * record can store why, rather than only that. */
export class EmailSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailSendError";
  }
}

@Injectable()
export class EmailService {
  private readonly apiKey: string;

  constructor(
    config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    // getOrThrow, not get: env.validation has already refused to boot without a well-shaped key,
    // so a miss here would mean the config module and the schema disagree — which should be loud.
    this.apiKey = config.getOrThrow<string>("RESEND_API_KEY");
    this.logger.setContext(EmailService.name);
  }

  /**
   * Hands one message to Resend. Resolves with the provider's message id on acceptance, throws
   * `EmailSendError` otherwise.
   *
   * **Acceptance is not delivery**, and the return type says only what is true: Resend has taken
   * responsibility for the message. Whether it reached a mailbox is a fact only Resend's webhooks
   * can supply (`email.delivered`, `email.bounced`, `email.complained`), and this change does not
   * consume them — see ADR-069, which lists them and says what each would mean.
   */
  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": input.idempotencyKey,
        },
        body: JSON.stringify({
          from: EMAIL_FROM,
          to: input.to,
          subject: input.subject,
          text: input.text,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      // A network failure and a timeout arrive here identically, and both mean the same thing to
      // the caller: we do not know whether Resend received it. The idempotency key is what makes
      // the retry safe rather than the error handling.
      throw new EmailSendError(
        `Resend request failed before a response: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const bodyText = await response.text();
    if (!response.ok) {
      // The provider's own words, kept verbatim — a delivery record saying "failed" without saying
      // why is a trace nobody can act on.
      throw new EmailSendError(`Resend returned ${response.status}: ${bodyText.slice(0, 500)}`);
    }

    let parsed: { id?: unknown };
    try {
      parsed = JSON.parse(bodyText) as { id?: unknown };
    } catch {
      throw new EmailSendError(`Resend returned ${response.status} with unparseable body`);
    }

    if (typeof parsed.id !== "string" || parsed.id.length === 0) {
      // A 200 without an id is not a success we can record or later correlate a webhook against.
      throw new EmailSendError(`Resend accepted the request but returned no message id`);
    }

    // The recipient is logged; the body is not. The body carries an invitation token, and
    // CLAUDE.md's logging rule puts secrets and tokens on the never-log list.
    this.logger.info({ to: input.to, providerMessageId: parsed.id }, "Email accepted by Resend");
    return { providerMessageId: parsed.id };
  }
}
