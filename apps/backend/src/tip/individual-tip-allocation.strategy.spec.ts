import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IndividualTipAllocationStrategy } from "./individual-tip-allocation.strategy";

describe("IndividualTipAllocationStrategy", () => {
  it("allocates the full tip amount to the paying Membership in exactly one line (ADR-007)", () => {
    const strategy = new IndividualTipAllocationStrategy();
    const membershipId = randomUUID();

    const lines = strategy.allocate(500n, membershipId);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ membershipId, amount: 500n });
  });

  it("lines always sum back to the tip amount — the invariant WebhooksService relies on for TIP_ALLOCATED to balance", () => {
    const strategy = new IndividualTipAllocationStrategy();
    const lines = strategy.allocate(777n, randomUUID());

    const sum = lines.reduce((total, line) => total + line.amount, 0n);
    expect(sum).toBe(777n);
  });
});
