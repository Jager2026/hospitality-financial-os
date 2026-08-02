import * as bcrypt from "bcryptjs";

const SALT_ROUNDS = 12;

/** CLAUDE.md, Logging Philosophy: "Never log: Passwords." — never log `password` or `hash`
 * anywhere in this module, including in error messages. */
export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, SALT_ROUNDS);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}
