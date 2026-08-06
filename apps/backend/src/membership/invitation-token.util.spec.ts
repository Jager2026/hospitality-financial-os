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

  it("verifies the correct token against its own hash", () => {
    const token = generateInvitationToken();
    const hash = hashInvitationToken(token);
    expect(verifyInvitationToken(token, hash)).toBe(true);
  });

  it("rejects an incorrect token against a real hash", () => {
    const hash = hashInvitationToken(generateInvitationToken());
    expect(verifyInvitationToken(generateInvitationToken(), hash)).toBe(false);
  });

  it("never stores the plaintext token in the hash output", () => {
    const token = generateInvitationToken();
    const hash = hashInvitationToken(token);
    expect(hash).not.toContain(token);
  });

  it("rejects a malformed/wrong-length stored hash instead of throwing", () => {
    // timingSafeEqual throws on mismatched buffer lengths — this is the guard that must catch
    // that case first. A plausible wrong implementation (comparing raw buffers without the
    // length check) would throw here instead of returning false.
    expect(() => verifyInvitationToken(generateInvitationToken(), "not-a-real-hash")).not.toThrow();
    expect(verifyInvitationToken(generateInvitationToken(), "not-a-real-hash")).toBe(false);
  });
});
