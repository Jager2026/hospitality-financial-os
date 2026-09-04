/**
 * ADR-070 — the words an email says, kept out of the code that decides to send it.
 *
 * **A dictionary rather than string literals, from the first message, and the reason is who
 * writes the second language.** Lithuanian is coming and will be written by a native speaker, not
 * translated by whoever happens to be editing the service that day. A literal buried in a service
 * has to be found before it can be translated; an entry in a table is already the work item.
 *
 * **Only `en` exists, and the locale is not selected — both deliberately.** An invitation is sent
 * to somebody who has no `User` row and therefore no `locale`: the system genuinely does not know
 * what language they read. The inviter's locale is a guess about a different person, and the
 * Restaurant's `defaultCustomerLocale` describes its diners rather than its staff. **This file is
 * where that decision will land when there is a second language to choose between**; inventing a
 * resolution rule now would be inventing a business rule to serve a table with one row.
 */

export type EmailLocale = "en";

export const DEFAULT_EMAIL_LOCALE: EmailLocale = "en";

interface InvitationCopyParams {
  inviterName: string;
  /** The Restaurant's name, or the Organization's when the invitation is org-wide. */
  placeName: string;
  roleName: string;
  acceptUrl: string;
  expiresInDays: number;
}

interface EmailCopy {
  subject: string;
  text: string;
}

/**
 * The invitation email. Short on purpose: who invited you, where, the link, and how long it lasts.
 *
 * **No HTML.** A plain-text transactional message is the one shape no client can render badly, it
 * cannot carry a tracking pixel, and it keeps the body small enough to read in a notification.
 * There is no template engine here and none is needed for one message.
 */
const INVITATION: Record<EmailLocale, (p: InvitationCopyParams) => EmailCopy> = {
  en: (p) => ({
    subject: `${p.inviterName} invited you to join ${p.placeName}`,
    text: [
      `${p.inviterName} has invited you to join ${p.placeName} as ${p.roleName}.`,
      ``,
      `Accept the invitation:`,
      p.acceptUrl,
      ``,
      `This link expires in ${p.expiresInDays} days. If you were not expecting this, you can ignore this email.`,
    ].join("\n"),
  }),
};

export function invitationEmail(locale: EmailLocale, params: InvitationCopyParams): EmailCopy {
  return INVITATION[locale](params);
}
