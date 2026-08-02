import { describe, expect, it } from "vitest";
import { registerSchema } from "./register.schema";

describe("registerSchema", () => {
  it("accepts a valid registration", () => {
    const result = registerSchema.safeParse({
      email: "Owner@Example.com",
      password: "sufficiently-long-password",
      locale: "en",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // lowercased/trimmed — case-insensitive email matching at the DB unique constraint depends on this
      expect(result.data.email).toBe("owner@example.com");
    }
  });

  it("rejects a malformed email", () => {
    const result = registerSchema.safeParse({ email: "not-an-email", password: "password123" });
    expect(result.success).toBe(false);
  });

  it("rejects a password shorter than 8 characters", () => {
    const result = registerSchema.safeParse({ email: "a@b.com", password: "short" });
    expect(result.success).toBe(false);
  });

  it("defaults locale to en when omitted", () => {
    const result = registerSchema.safeParse({ email: "a@b.com", password: "password123" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.locale).toBe("en");
    }
  });
});
