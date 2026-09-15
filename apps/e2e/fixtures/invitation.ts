import { queryOne } from "./db";

/**
 * The invitation link, read where the recipient would read it: out of the queued email.
 *
 * **Not from the API response, because it is not there** — `POST /memberships` returns an id and
 * the address and deliberately no token (ADR-070). A token in two places means the mail path is
 * never the one anybody exercises: the console keeps working, the message quietly stops arriving,
 * and nothing says so. So a browser test that wants the link has to take the recipient's route.
 *
 * A read, not a write, so it sits inside the narrow rule `org.ts` states for direct database
 * access: the thing under test is the acceptance flow, and this only fetches the message that flow
 * depends on.
 */
export interface QueuedInvitation {
  acceptPath: string;
  token: string;
  subject: string;
}

const EMAIL_EVENT_TYPE = "email.send_requested";

/**
 * **Start watching BEFORE the invite is sent, and take the body the moment it exists.**
 *
 * The queued email's body is destroyed by the product on purpose: `EmailService` refuses to send
 * outside production, the Outbox poller abandons the event, and ADR-075 replaces the text so a live
 * address and a live token do not sit in the queue forever. **The token exists exactly once, in
 * that body** (ADR-070), so once the poller has been there, there is nothing left to read and
 * nothing to fall back to.
 *
 * Reading "as soon as possible after the click" is not enough — measured: on a freshly reset
 * database the poller has nothing older to work through and reaches a brand-new invitation before
 * a single UI assertion completes, every time. So this watcher starts first and polls every 50 ms;
 * the row is written before the API responds, which puts the read milliseconds after it exists and
 * up to two seconds ahead of the poller's next tick.
 */
export function watchForInvitationLink(
  to: string,
  timeoutMs = 10_000,
): { settled: Promise<QueuedInvitation> } {
  const deadline = Date.now() + timeoutMs;
  const settled = (async () => {
    let lastBody: string | null = null;
    for (;;) {
      const row = await queryOne<{ payload: { subject?: string; text?: string } }>(
        `SELECT payload FROM outbox_event
          WHERE event_type = $1 AND payload->>'to' = $2
          ORDER BY created_at DESC
          LIMIT 1`,
        [EMAIL_EVENT_TYPE, to],
      );
      const text = row?.payload.text ?? null;
      if (text !== null) {
        lastBody = text;
        const match = /https?:\/\/\S+/.exec(text);
        if (match) return toQueuedInvitation(to, match[0]);
      }
      if (Date.now() > deadline) {
        throw new Error(
          `No invitation link for ${to} within ${timeoutMs}ms. Last body seen: ` +
            `${JSON.stringify(lastBody)} — a redaction marker there means the Outbox poller reached ` +
            `the event before this watcher did (ADR-075), and the link is gone rather than missing.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })();
  // Attached now so a rejection before the caller awaits does not surface as an unhandled one.
  settled.catch(() => undefined);
  return { settled };
}

function toQueuedInvitation(to: string, href: string): QueuedInvitation {
  const url = new URL(href);
  const token = url.searchParams.get("token");
  if (token === null || token === "") {
    throw new Error(`The invitation link for ${to} carries no token: ${href}`);
  }
  // The path and query only. The absolute URL is built from the API's own `FRONTEND_URL`, which in
  // this harness is not the port Playwright serves — following it verbatim would test the wrong
  // origin, and following it silently would be worse than failing.
  return { acceptPath: `${url.pathname}${url.search}`, token, subject: "" };
}

export async function readInvitationLink(to: string): Promise<QueuedInvitation> {
  const row = await queryOne<{ payload: { subject?: string; text?: string } }>(
    `SELECT payload FROM outbox_event
      WHERE event_type = $1 AND payload->>'to' = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [EMAIL_EVENT_TYPE, to],
  );

  if (!row) throw new Error(`No invitation email was queued for ${to}`);
  const text = row.payload.text ?? "";
  const match = /https?:\/\/\S+/.exec(text);
  if (!match) {
    // **Name the cause, because "contains no link" sends the next reader looking at the mailer.**
    // The body is redacted by the product on purpose: EmailService refuses to send outside
    // production, the Outbox poller abandons the event, and ADR-075 replaces the text so a live
    // address and a live token do not sit in the queue forever. If the poller got there first,
    // this is what is left — and the token exists exactly once, in that body, so there is nothing
    // to fall back to. The remedy is to read sooner, which is why the caller reads before it
    // asserts anything else.
    throw new Error(
      `The invitation email to ${to} carries no link. Its body reads ${JSON.stringify(text)} — ` +
        `if that is a redaction marker, the Outbox poller reached the event before this read did ` +
        `(ADR-075), and the link is gone rather than missing.`,
    );
  }

  const url = new URL(match[0]);
  const token = url.searchParams.get("token");
  if (token === null || token === "") {
    throw new Error(`The invitation link for ${to} carries no token: ${match[0]}`);
  }

  // The path and query only. The absolute URL is built from the API's own `FRONTEND_URL`, which in
  // this harness is not the port Playwright serves — following it verbatim would test the wrong
  // origin, and following it silently would be worse than failing.
  return { acceptPath: `${url.pathname}${url.search}`, token, subject: "" };
}
