import { createHash } from "node:crypto";

/** Deterministic hash of a request body, independent of key order — ADR-004's
 * "request fingerprint." Two requests with the same Idempotency-Key must produce the same
 * fingerprint if and only if their bodies are semantically identical. */
export function computeFingerprint(body: unknown): string {
  return createHash("sha256").update(stableStringify(body)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
  );
  return `{${entries.join(",")}}`;
}
