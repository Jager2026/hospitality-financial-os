import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { hashPassword } from "../auth/password.util";

/**
 * Emptying a person while the financial record stays intact — the mechanism behind a GDPR erasure
 * request (`PERSONAL_DATA_MAP.md` §6, ADR-052).
 *
 * **Why emptying and not deletion.** `AuditLog.userId` is `ON DELETE SET NULL`, so deleting the
 * row would silently blank the actor on every audit entry this person ever produced — erasure and
 * auditability in direct conflict. Keeping the row and clearing its fields has neither problem:
 * the foreign keys stay valid, `Refund.requestedBy` / `Adjustment.createdBy` still resolve, and
 * nothing about the financial history moves.
 *
 * **Why the financial rows are retained, stated as a period rather than as caution.**
 * `Membership`, `LedgerLine`, `Payment`, `Wallet`, `Transaction`, `Refund` and `Adjustment` are
 * kept because the ten-year accounting retention floor requires them. That is a lawful-basis
 * answer, not a reluctance to delete. It is survivable only because of the boundary in
 * `PERSONAL_DATA_MAP.md` §2: every one of those rows attributes to `Membership.id`, which carries
 * no name, no email and no contact detail. **The person can be emptied because the money was never
 * pointed at the person.**
 *
 * **Not a Nest provider, and deliberately not wired into any module.** A route that empties a user
 * is the most dangerous thing this codebase could expose, and a subject-rights request at five
 * restaurants is a manual, verified act rather than a self-service button. `repo-invariants.spec.ts`
 * fails if any `.module.ts` or `.controller.ts` imports this file — the constraint is enforced
 * rather than described.
 */

/** Cleared by `executeRedaction`. Every String field on `User` must appear in exactly one of these
 * two lists; `repo-invariants.spec.ts` parses `schema.prisma` and fails if a new one appears in
 * neither. That check is the only part of this file that survives someone adding a column and not
 * reading this comment. */
export const REDACTED_USER_STRING_FIELDS = ["email", "displayName", "passwordHash"] as const;

/** Retained, with the reason attached to each rather than left to inference.
 *  - `id` — the join key. A UUID that identifies a row, not a person, and the thing every retained
 *    financial row indirectly hangs from. Erasing it would mean deletion, which is the option
 *    rejected above.
 *  - `locale` — a display preference. Not an identifier, and no more revealing than the fact that
 *    a row exists at all. */
export const RETAINED_USER_STRING_FIELDS = ["id", "locale"] as const;

/** `.invalid` is reserved by RFC 2606 and can never be routable, so a tombstone can never
 * accidentally become a deliverable address. Unique per redaction, not a shared constant: `email`
 * is `@unique`, and a second erasure would collide with the first — which would surface as a
 * database error during someone's GDPR request, the worst possible moment. */
export function tombstoneEmail(): string {
  return `redacted-${randomUUID()}@invalid`;
}

export const REDACTED_DISPLAY_NAME = "Redacted user";

export interface RedactionPlan {
  userId: string;
  originalEmail: string;
  tombstone: string;
  /** `MembershipInvitation` rows carrying this email. It lives there independently of `User` — an
   * invitation records an address for someone who may never have had an account. */
  invitationRows: number;
  /** Retained, and reported so the operator sees that the financial subject survives. */
  membershipsRetained: number;
  /** Rows still carrying `ipAddress`/`userAgent` after the User is emptied. Reported because
   * emptying `User` does not reach them, and an erasure that quietly leaves IP addresses behind is
   * not an erasure. */
  auditRowsWithRequestMetadata: number;
  acceptanceRowsWithRequestMetadata: number;
}

export class UserNotFoundError extends Error {}
export class AlreadyRedactedError extends Error {}

/** Reads the current state and reports what a redaction would touch. Writes nothing — the CLI runs
 * this on its own first, so a run without `--confirm` is a description rather than an action. */
export async function planRedaction(prisma: PrismaClient, email: string): Promise<RedactionPlan> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new UserNotFoundError(`No User with email ${email}.`);
  }
  if (user.deletedAt !== null) {
    throw new AlreadyRedactedError(
      `User ${user.id} already has deletedAt set (${user.deletedAt.toISOString()}). ` +
        `Refusing rather than redacting twice — a second run would replace one tombstone with ` +
        `another and destroy the audit trail of when the first erasure happened.`,
    );
  }

  const [invitationRows, membershipsRetained, auditRows, acceptanceRows] = await Promise.all([
    prisma.membershipInvitation.count({ where: { email } }),
    prisma.membership.count({ where: { userId: user.id } }),
    prisma.auditLog.count({
      where: { userId: user.id, OR: [{ ipAddress: { not: null } }, { userAgent: { not: null } }] },
    }),
    prisma.agreementAcceptance.count({
      where: { userId: user.id, OR: [{ ipAddress: { not: null } }, { userAgent: { not: null } }] },
    }),
  ]);

  return {
    userId: user.id,
    originalEmail: user.email,
    tombstone: tombstoneEmail(),
    invitationRows,
    membershipsRetained,
    auditRowsWithRequestMetadata: auditRows,
    acceptanceRowsWithRequestMetadata: acceptanceRows,
  };
}

export interface RedactionOptions {
  /** Also null `ipAddress`/`userAgent` on this user's `AuditLog` and `AgreementAcceptance` rows.
   *
   * Off by default, and the default is not a recommendation — it is the absence of a decision.
   * Whether those fields are retained as security records or erased with the person is an open
   * policy question (`PERSONAL_DATA_MAP.md` §6), and this mechanism must not settle it by picking
   * a convenient default. The plan reports the row count either way, so a partial erasure is
   * always visible to the person performing it rather than discovered later. */
  clearRequestMetadata?: boolean;
}

/**
 * Applies the plan in one transaction.
 *
 * `passwordHash` is replaced with a real bcrypt hash of a discarded random value rather than with
 * a placeholder string. The column is `NOT NULL`, and a non-bcrypt value would make `bcrypt.compare`
 * behaviour depend on the library's handling of a malformed hash — a detail nobody should have to
 * know when reading an erasure routine. A hash of something nobody has ever seen simply cannot
 * match. Login is already refused earlier than this, on `deletedAt` (`auth.service.ts`), so this is
 * the second of two independent reasons the account cannot be entered.
 */
export async function executeRedaction(
  prisma: PrismaClient,
  plan: RedactionPlan,
  options: RedactionOptions = {},
): Promise<void> {
  const unusablePasswordHash = await hashPassword(randomUUID());

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: plan.userId },
      data: {
        email: plan.tombstone,
        displayName: REDACTED_DISPLAY_NAME,
        passwordHash: unusablePasswordHash,
        lastLogin: null,
        emailVerified: false,
        twoFactorEnabled: false,
        status: "INACTIVE",
        deletedAt: new Date(),
      },
    });

    // Matched on the ORIGINAL email, which is why this runs inside the same transaction as the
    // User update rather than after it — between the two writes the address would still be
    // findable here, and a failure in between would leave it findable for good.
    await tx.membershipInvitation.updateMany({
      where: { email: plan.originalEmail },
      data: { email: plan.tombstone },
    });

    if (options.clearRequestMetadata === true) {
      await tx.auditLog.updateMany({
        where: { userId: plan.userId },
        data: { ipAddress: null, userAgent: null },
      });
      await tx.agreementAcceptance.updateMany({
        where: { userId: plan.userId },
        data: { ipAddress: null, userAgent: null },
      });
    }
  });
}
