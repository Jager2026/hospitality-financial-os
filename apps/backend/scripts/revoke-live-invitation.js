#!/usr/bin/env node
/**
 * Revokes the invitation created by a LIVE production verification, and nothing else.
 *
 * ═══ NOTHING TO REVOKE YET (ADR-071) ═══
 *
 * Founder decision, 2026-09-04: the live check waits for the first real venue, so no verification
 * invitation exists and this script has no work to do. It is kept because it is exactly what that
 * first real invitation will need. Its companion is `live-invitation-check.js`, which carries the
 * same marker and must not be run before then either.
 *
 * Run against production today and it refuses on its own terms — zero matches for any address is
 * one of the five conditions it declines to guess past.
 *
 * WHY THIS EXISTS, and it is not tidiness. A live check of the invitation email (ADR-070) creates
 * a real, working credential: a token that grants membership of a real Organization, valid for
 * seven days, sitting in a mailbox. Leaving it there after the check is the actual risk — bigger
 * than the leftover row, which is merely untidy. There is no API route that revokes an invitation
 * (`membership.controller.ts` has POST, PATCH and disable, no delete), so this is the only way to
 * withdraw one, and it talks to the database directly.
 *
 * THE GUARD IS ON THE COMMAND LINE, not inside a service, because that is where the only caller is
 * a human. CLAUDE.md's rule: a mechanism that legitimate work has to bypass routinely degrades
 * into a rubber stamp — so ask who has to get past it on an ordinary day. Nobody does. No test, no
 * migration and no application code calls this file.
 *
 * IT REFUSES ON ANYTHING IT DID NOT EXPECT rather than doing its best:
 *   - zero matches           → refuses (nothing to revoke; probably the wrong email or database)
 *   - more than one match    → refuses (it will not guess which one the check created)
 *   - the invitation is accepted → refuses (that is a real Membership now, not a leftover)
 *
 * Usage:
 *   node scripts/revoke-live-invitation.js --email someone@example.com          # dry run
 *   node scripts/revoke-live-invitation.js --email someone@example.com --apply  # revoke
 *
 * DATABASE_URL must point at the database being cleaned. It is never printed.
 */

const { PrismaClient } = require("@prisma/client");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

function fail(message) {
  console.error(`\n  REFUSING: ${message}\n`);
  process.exit(2);
}

async function main() {
  const email = arg("email");
  const apply = process.argv.includes("--apply");

  if (!email) {
    fail("--email is required. This script never operates on 'the most recent' anything.");
  }
  if (!process.env.DATABASE_URL) {
    fail("DATABASE_URL is not set. Refusing to fall back to any default.");
  }

  const prisma = new PrismaClient();
  try {
    const matches = await prisma.membershipInvitation.findMany({
      where: { email },
      select: { id: true, email: true, acceptedAt: true, expiresAt: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });

    if (matches.length === 0) {
      fail(`no invitation exists for ${email}. Wrong address, or wrong database.`);
    }
    if (matches.length > 1) {
      console.error(`\n  Found ${matches.length} invitations for ${email}:`);
      for (const m of matches) {
        console.error(
          `    ${m.id}  created ${m.createdAt.toISOString()}  accepted=${!!m.acceptedAt}`,
        );
      }
      fail("more than one match. This script will not guess which one the live check created.");
    }

    const [invitation] = matches;
    if (invitation.acceptedAt) {
      fail(
        `the invitation for ${email} was ACCEPTED at ${invitation.acceptedAt.toISOString()}. ` +
          `That is a real Membership now, not a leftover — revoking it here would delete history ` +
          `rather than withdraw a credential.`,
      );
    }

    console.log(`\n  Invitation for ${email}`);
    console.log(`    id:        ${invitation.id}`);
    console.log(`    created:   ${invitation.createdAt.toISOString()}`);
    console.log(`    expires:   ${invitation.expiresAt.toISOString()}`);
    console.log(`    accepted:  no`);

    if (!apply) {
      console.log(`\n  Dry run. Nothing was changed. Re-run with --apply to revoke it.\n`);
      return;
    }

    await prisma.membershipInvitation.delete({ where: { id: invitation.id } });
    console.log(`\n  Revoked. The link in that mailbox no longer grants anything.\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
