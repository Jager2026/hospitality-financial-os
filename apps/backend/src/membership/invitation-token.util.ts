import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_BYTES = 32; // 256 bits of entropy — not guessable, unlike a short numeric code

/** ADR-020: the raw token is handed to the caller exactly once, at creation — never stored. */
export function generateInvitationToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

// SHA-256, not bcrypt (unlike auth/password.util.ts): bcrypt's deliberate slowness exists to
// defend against offline brute-forcing a LOW-entropy secret a human chose — irrelevant here,
// since this token is 256 bits of crypto.randomBytes and brute-forcing it is infeasible
// regardless of hash speed. bcrypt would also silently truncate any input past 72 bytes (an
// algorithm property, not a bcryptjs quirk) — today's 64-byte hex token fits, but that's a
// landmine for whoever raises TOKEN_BYTES later without knowing the limit exists. SHA-256 has
// no such ceiling.
export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Same shape as password verification (ADR-020) — look up candidates by email, never by the
 * token itself, then compare here. Uses crypto.timingSafeEqual rather than `===` so a mismatch
 * can't leak information about how many leading bytes matched via response-time differences —
 * meaningful here since, unlike bcrypt.compare, SHA-256 comparison has no built-in per-call cost
 * to mask a naive string comparison's early-exit behavior. */
export function verifyInvitationToken(token: string, hash: string): boolean {
  const candidate = Buffer.from(hashInvitationToken(token), "hex");
  const stored = Buffer.from(hash, "hex");
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}
