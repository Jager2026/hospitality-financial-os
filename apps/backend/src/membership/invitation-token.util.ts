import { randomBytes } from "node:crypto";
import * as bcrypt from "bcryptjs";

const SALT_ROUNDS = 12; // matches auth/password.util.ts's own constant — same algorithm, kept
// as a separate small module rather than a shared abstraction (CLAUDE.md: "Three similar lines
// is better than a premature abstraction").
const TOKEN_BYTES = 32; // 256 bits of entropy — not guessable, unlike a short numeric code

/** ADR-020: the raw token is handed to the caller exactly once, at creation — never stored. */
export function generateInvitationToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

export async function hashInvitationToken(token: string): Promise<string> {
  return bcrypt.hash(token, SALT_ROUNDS);
}

/** Same shape as password verification (ADR-020) — never a lookup keyed on the token itself. */
export async function verifyInvitationToken(token: string, hash: string): Promise<boolean> {
  return bcrypt.compare(token, hash);
}
