import { Controller, Get } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

// API_Contract.md, CURRENCIES: GET /currencies — populates onboarding/currency-selection fields.
// No auth guard: this is static reference data (ADR-001), not restaurant/user-specific.
@Controller("currencies")
export class CurrencyController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  findAll() {
    return this.prisma.currency.findMany({ orderBy: { code: "asc" } });
  }
}
