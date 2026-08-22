import { afterEach, describe, expect, it, vi } from "vitest";
import { isPasswordBreached } from "./hibp.util";

// "password" -> SHA-1 5baa61e4c9b93f3f0682250b6cf8331b7ee68fd8 (a real, well-known breached
// password — used here only as a fixture value, never a credential of anything real).
const KNOWN_BREACHED_PASSWORD = "password";
const BREACHED_PREFIX = "5BAA6";
const BREACHED_SUFFIX = "1E4C9B93F3F0682250B6CF8331B7EE68FD8";

describe("isPasswordBreached", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns true when the API's range response includes this password's exact hash suffix — discriminating: a naive implementation checking only the prefix (not matching the full suffix) would return true for ANY password sharing this 5-char prefix", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(`${BREACHED_SUFFIX}:3730471\r\nSOMEOTHERSUFFIXVALUE0000000000000000:1`),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await isPasswordBreached(KNOWN_BREACHED_PASSWORD);

    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      `https://api.pwnedpasswords.com/range/${BREACHED_PREFIX}`,
      expect.anything(),
    );
  });

  it("returns false when the response has other suffixes but not this password's own", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(
          "SOMEOTHERSUFFIXVALUE0000000000000000:1\r\nANOTHERONE00000000000000000000000000:5",
        ),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await isPasswordBreached("a-genuinely-unique-passphrase-never-breached-2026xyz");

    expect(result).toBe(false);
  });

  it("fails open (returns false, never throws) when the HIBP API is unreachable — a third-party outage must not block registration", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("simulated network failure")));

    const result = await isPasswordBreached("anything");

    expect(result).toBe(false);
  });

  it("fails open when the API responds with a non-2xx status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    const result = await isPasswordBreached("anything");

    expect(result).toBe(false);
  });

  it("never sends the plaintext password or its full hash to the API — only the 5-char prefix", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("") });
    vi.stubGlobal("fetch", fetchSpy);

    await isPasswordBreached("correct horse battery staple");

    const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(calledUrl).not.toContain("correct horse battery staple");
    expect(calledUrl.split("/").pop()).toHaveLength(5); // exactly the k-anonymity prefix, nothing more
  });
});
