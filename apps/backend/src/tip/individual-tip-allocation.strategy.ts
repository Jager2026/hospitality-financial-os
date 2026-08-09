import { Injectable } from "@nestjs/common";
import type { TipAllocationLine, TipAllocationStrategy } from "./tip-allocation-strategy.interface";

/** ADR-007's MVP strategy: the entire tip goes to the person who took the payment
 * (Payment.waiterMembershipId, ADR-022) — always exactly one line. Pool, Shift, Percentage, and
 * Role-based strategies (ADR-007) are designed for but not implemented until a real restaurant
 * needs one. */
@Injectable()
export class IndividualTipAllocationStrategy implements TipAllocationStrategy {
  allocate(tipAmount: bigint, payingMembershipId: string): TipAllocationLine[] {
    return [{ membershipId: payingMembershipId, amount: tipAmount }];
  }
}
