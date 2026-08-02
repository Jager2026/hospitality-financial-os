import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.util";

describe("password.util", () => {
  it("verifies the correct password against its own hash", async () => {
    const hash = await hashPassword("correct horse battery staple");
    await expect(verifyPassword("correct horse battery staple", hash)).resolves.toBe(true);
  });

  it("rejects an incorrect password against a real hash", async () => {
    const hash = await hashPassword("correct horse battery staple");
    await expect(verifyPassword("wrong password", hash)).resolves.toBe(false);
  });

  it("never stores the plaintext password in the hash output", async () => {
    const plaintext = "correct horse battery staple";
    const hash = await hashPassword(plaintext);
    expect(hash).not.toContain(plaintext);
  });

  it("produces a different hash for the same password on each call (random salt)", async () => {
    const [hashA, hashB] = await Promise.all([
      hashPassword("same password"),
      hashPassword("same password"),
    ]);
    expect(hashA).not.toBe(hashB);
  });
});
