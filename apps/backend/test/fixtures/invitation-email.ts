import type { PrismaClient } from "@prisma/client";
import { EMAIL_OUTBOX_EVENT_TYPE } from "../../src/email/email-outbox.service";

/**
 * ADR-070 — how a test reads the invitation the way its recipient would.
 *
 * **`POST /memberships` no longer returns the token.** It used to, because there was nowhere else
 * for it to go; now the email is the only path, and a test that still took a shortcut through the
 * API response would be exercising a path nobody uses. So the tests read the queued message
 * instead — which also means every one of them asserts, incidentally but genuinely, that the email
 * really was enqueued and really does contain a usable link.
 *
 * The payload is still readable here because it is only redacted on a SUCCESSFUL send, and the
 * transport refuses to send outside production (ADR-070). In a test run the message is therefore
 * recorded, never delivered, and its body stays available — which is what makes this reliable
 * rather than a race against the poller.
 */
export interface InvitationEmail {
  to: string;
  subject: string;
  text: string;
  acceptUrl: string;
  token: string;
}

export async function readInvitationEmail(
  prisma: PrismaClient,
  to: string,
): Promise<InvitationEmail> {
  const events = await prisma.outboxEvent.findMany({
    where: { eventType: EMAIL_OUTBOX_EVENT_TYPE },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  for (const event of events) {
    const payload = event.payload as { to?: unknown; subject?: unknown; text?: unknown };
    if (payload.to !== to || typeof payload.text !== "string") continue;

    const match = /https?:\/\/\S+/.exec(payload.text);
    if (!match) {
      throw new Error(`The invitation email to ${to} contains no link`);
    }
    const acceptUrl = match[0];
    const token = new URL(acceptUrl).searchParams.get("token");
    if (!token) {
      throw new Error(`The invitation link to ${to} carries no token: ${acceptUrl}`);
    }
    return {
      to,
      subject: String(payload.subject ?? ""),
      text: payload.text,
      acceptUrl,
      token,
    };
  }

  throw new Error(`No invitation email was enqueued for ${to}`);
}
