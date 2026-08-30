import { PrismaClient } from "@prisma/client";
import {
  AlreadyRedactedError,
  UserNotFoundError,
  executeRedaction,
  planRedaction,
} from "../src/user-redaction/redact-user";

/**
 * The human-facing entry point for a GDPR erasure request (ADR-052).
 *
 * **Dry run by default; `--confirm` executes.** Same shape as `seed.ts`'s `--allow-revocations`
 * gate, and for the same reason: the gate belongs on the entry point a human uses, never inside
 * the library function, so tests and any future caller are not forced to bypass it routinely. A
 * mechanism legitimate work has to get past every day stops being read.
 *
 * A flag rather than an interactive prompt, also for the seed's reason — a prompt cannot be
 * reviewed, and it hangs anywhere without a terminal. Here it additionally means the operator has
 * seen the plan printed before the flag is added to the command, which is the whole point of the
 * two-step shape.
 *
 * **No HTTP route does this and none should.** A subject-rights request at five restaurants is a
 * manual, verified act; an endpoint that empties a user is the most dangerous thing this codebase
 * could expose, and would need its own authorization story to be no safer than a person at a
 * terminal. `repo-invariants.spec.ts` fails if the library is ever imported by a module or a
 * controller.
 *
 *   pnpm --filter backend run redact:user -- --email=someone@example.com
 *   pnpm --filter backend run redact:user -- --email=someone@example.com --confirm
 */

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found?.slice(prefix.length);
}

async function main(): Promise<void> {
  const email = arg("email");
  const confirm = process.argv.includes("--confirm");
  const clearRequestMetadata = process.argv.includes("--clear-request-metadata");

  // Checked for emptiness, not just presence: `--email=` is a present argument holding "", and an
  // erasure run that proceeded on it would look up the empty string. The fifth appearance of that
  // distinction in this codebase (CLAUDE.md, Workspace Hygiene).
  if (email === undefined || email.trim() === "") {
    console.error("\n  Usage: redact:user -- --email=<address> [--confirm]\n");
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient();
  try {
    const plan = await planRedaction(prisma, email);

    console.log(`\n  User ${plan.userId}`);
    console.log(`    email        -> ${plan.tombstone}`);
    console.log(`    displayName  -> redacted`);
    console.log(`    passwordHash -> replaced with an unusable value`);
    console.log(`    deletedAt    -> now, status -> INACTIVE`);
    console.log(`    ${plan.invitationRows} MembershipInvitation row(s) carrying this address`);
    console.log(
      `\n  RETAINED — required by the ten-year accounting floor, not caution ` +
        `(PERSONAL_DATA_MAP.md §6):`,
    );
    console.log(
      `    ${plan.membershipsRetained} Membership row(s), and every Ledger, Payment, Wallet,`,
    );
    console.log(`    Transaction, Refund and Adjustment row attributed to them.`);

    const metadataRows = plan.auditRowsWithRequestMetadata + plan.acceptanceRowsWithRequestMetadata;
    if (metadataRows > 0 && !clearRequestMetadata) {
      // Printed on every run, deliberately. Whether these are retained as security records or
      // erased with the person is an open policy question, and a mechanism that quietly left them
      // behind would let an erasure be reported as complete when it is not.
      console.log(
        `\n  NOT ERASED — ${metadataRows} row(s) still carry this person's ipAddress/userAgent\n` +
          `    (${plan.auditRowsWithRequestMetadata} AuditLog, ` +
          `${plan.acceptanceRowsWithRequestMetadata} AgreementAcceptance).\n` +
          `    Whether those are retained as security records or erased with the person is an\n` +
          `    OPEN decision (PERSONAL_DATA_MAP.md §6). Pass --clear-request-metadata to erase\n` +
          `    them. Until that decision is recorded, this erasure is partial — say so if you\n` +
          `    are answering the subject in writing.`,
      );
    }

    if (!confirm) {
      console.log(`\n  Nothing has been changed. Re-run with --confirm to apply.\n`);
      return;
    }

    await executeRedaction(prisma, plan, { clearRequestMetadata });
    console.log(`\n  Done. User ${plan.userId} emptied; financial history untouched.\n`);
  } catch (err) {
    if (err instanceof UserNotFoundError || err instanceof AlreadyRedactedError) {
      console.error(`\n  ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
