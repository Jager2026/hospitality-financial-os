// Prisma maps Postgres BIGINT columns (ADR-001: money stored as BIGINT minor units — Payment,
// Transaction, LedgerLine, ...) to JS `bigint`, which JSON.stringify cannot serialize natively —
// every money-bearing API response would throw TypeError without this. Sprint 5 is the first
// endpoint to return one of these fields; every later one (Sprint 6+) gets this for free rather
// than each remembering its own conversion. Serializes as a STRING, not a Number, so no value is
// ever silently rounded through a float — the one conversion point for the entire API.
export {};

declare global {
  interface BigInt {
    toJSON(): string;
  }
}

Object.defineProperty(BigInt.prototype, "toJSON", {
  value(this: bigint): string {
    return this.toString();
  },
});
