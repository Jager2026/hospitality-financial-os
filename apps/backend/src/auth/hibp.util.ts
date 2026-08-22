import { createHash } from "node:crypto";

const HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range/";

/** THREAT_MODEL.md: "No ... breached-password check" (OWASP A07:2025). k-anonymity range query —
 * only the first 5 hex chars of the SHA-1 hash ever leave this process, never the password or its
 * full hash (CLAUDE.md, Logging Philosophy's "never log passwords" extends to never transmitting
 * one, even hashed, in a way that could identify it). Called only at password-SET time
 * (registration, invitation-accept) — never at login, where the password already exists and an
 * external call on every sign-in would add latency without preventing anything.
 *
 * Fails open: if the HIBP API itself is unreachable, registration should not be blocked by a
 * third-party outage having nothing to do with this platform's own availability — the check is a
 * defense-in-depth improvement, not a hard security boundary this system depends on. */
export async function isPasswordBreached(password: string): Promise<boolean> {
  const sha1 = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  try {
    const response = await fetch(`${HIBP_RANGE_URL}${prefix}`, {
      headers: { "Add-Padding": "true" },
    });
    if (!response.ok) {
      return false;
    }
    const body = await response.text();
    return body.split("\r\n").some((line) => line.startsWith(`${suffix}:`));
  } catch {
    return false;
  }
}
