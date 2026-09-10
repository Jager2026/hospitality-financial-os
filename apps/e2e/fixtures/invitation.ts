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
  if (!match) throw new Error(`The invitation email to ${to} contains no link`);

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
