import type { PrismaService } from "../../src/prisma/prisma.service";
import type { PinoLogger } from "nestjs-pino";
import { ShiftService } from "../../src/shift/shift.service";

/**
 * A real `ShiftService` with a silent logger, for the specs that construct `LedgerService`
 * directly rather than through a Nest module.
 *
 * **Deliberately the real service, not a stub.** ADR-064 stamps every LedgerLine with its Shift
 * inside the posting transaction; a stub returning a fixed id would let every one of those specs
 * pass against an implementation that never opens a shift at all, which is precisely the thing
 * the entity exists to do. The cost is that these specs now write Shift rows — which is correct:
 * they are posting real Ledger entries, and a real entry belongs to a real shift.
 */
export function shiftServiceForTests(prisma: PrismaService): ShiftService {
  const silent = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as unknown as PinoLogger;
  return new ShiftService(prisma, silent);
}
