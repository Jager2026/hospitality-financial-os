import { describe, expect, it } from "vitest";
import {
  generateInvitationToken,
  hashInvitationToken,
  verifyInvitationToken,
} from "./invitation-token.util";

describe("invitation-token.util", () => {
  it("generates a different token on each call", () => {
    expect(generateInvitationToken()).not.toBe(generateInvitationToken());
  });

  it("generates a high-entropy token, not a short guessable code", () => {
    expect(generateInvitationToken().length).toBeGreaterThanOrEqual(64); // 32 bytes, hex-encoded
  });

  it("verifies the correct token against its own hash", async () => {
    const token = generateInvitationToken();
    const hash = await hashInvitationToken(token);
    expect(await verifyInvitationToken(token, hash)).toBe(true);
  });

  it("rejects an incorrect token against a real hash", async () => {
    const hash = await hashInvitationToken(generateInvitationToken());
    expect(await verifyInvitationToken(generateInvitationToken(), hash)).toBe(false);
  });

  it("never stores the plaintext token in the hash output", async () => {
    const token = generateInvitationToken();
    const hash = await hashInvitationToken(token);
    expect(hash).not.toContain(token);
  });
});
