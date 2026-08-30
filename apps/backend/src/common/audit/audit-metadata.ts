import type { Prisma } from "@prisma/client";
import type { PrismaService } from "../../prisma/prisma.service";

/**
 * The only shape `AuditLog.metadata` may hold, and the only function that writes an audit row.
 *
 * `metadata` is a Prisma `Json?` column, which accepts anything. `PERSONAL_DATA_MAP.md` §3 named it
 * as the one field in this schema where personal data can accumulate **without anyone deciding that
 * it should** — no migration, no review, just an interceptor passing a slightly larger object.
 *
 * The mechanism against that is a type rather than a rule, and the difference matters: adding a
 * personal field becomes a **compile error at the call site**, not something a reviewer has to
 * notice. Widening it is still possible — but only by editing the interface below, in a file whose
 * entire purpose is that decision, which is exactly where the question should be asked.
 *
 * Deliberately NOT a runtime scan for personal-looking key names. That needs a list of words that
 * "look personal", the list needs maintaining, and someone eventually edits it to make a build
 * green — the rubber-stamp degradation `CLAUDE.md` names. A closed type needs no list.
 *
 * Every key here is a machine identifier or a protocol value. None of them identifies a person:
 * `waiterMembershipId` is a Membership id, which `PERSONAL_DATA_MAP.md` §2 establishes is already
 * a pseudonym.
 */
export interface AuditMetadata {
  /** HTTP status of the failed request, or null when the failure carried no HTTP status. */
  statusCode?: number | null;
  /** The application's own error code, or null when the failure carried none. */
  code?: string | null;
  /** Refresh-token family, for reuse detection (ADR-019). */
  familyId?: string;
  /** ADR-033: which Membership a tip was attributed to. A pseudonym, not a person. */
  waiterMembershipId?: string;
}

export interface AuditLogEntry {
  userId: string | null;
  entity: string;
  entityId: string;
  action: string;
  metadata: AuditMetadata;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * The single writer. `repo-invariants.spec.ts` fails if `auditLog.create` appears anywhere else —
 * without that, the type above would be advice rather than a constraint, since Prisma will accept
 * any object handed to it directly.
 */
export async function writeAuditLog(prisma: PrismaService, entry: AuditLogEntry): Promise<void> {
  // The one place the closed type meets Prisma's open `Json` column. Casting here rather than at
  // each call site is the point: this is the boundary the type exists to guard, and it is crossed
  // exactly once.
  await prisma.auditLog.create({
    data: { ...entry, metadata: entry.metadata as Prisma.InputJsonValue },
  });
}
