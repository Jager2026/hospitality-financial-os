import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ISO 4217 reference data (ADR-001). Not exhaustive — a curated set covering: EUR (required,
// ADR-012's launch currency), other major currencies a restaurant guest might reasonably pay
// with, and a deliberate sample of non-2-exponent currencies (JPY: 0, BHD: 3) proving the
// exponent-lookup mechanism ADR-001 exists for actually matters, not just EUR/USD where every
// exponent happens to be 2.
const CURRENCIES = [
  { code: "EUR", exponent: 2, name: "Euro" },
  { code: "USD", exponent: 2, name: "US Dollar" },
  { code: "GBP", exponent: 2, name: "British Pound" },
  { code: "CHF", exponent: 2, name: "Swiss Franc" },
  { code: "SEK", exponent: 2, name: "Swedish Krona" },
  { code: "NOK", exponent: 2, name: "Norwegian Krone" },
  { code: "DKK", exponent: 2, name: "Danish Krone" },
  { code: "PLN", exponent: 2, name: "Polish Zloty" },
  { code: "CZK", exponent: 2, name: "Czech Koruna" },
  { code: "RON", exponent: 2, name: "Romanian Leu" },
  { code: "JPY", exponent: 0, name: "Japanese Yen" },
  { code: "KRW", exponent: 0, name: "South Korean Won" },
  { code: "BHD", exponent: 3, name: "Bahraini Dinar" },
  { code: "KWD", exponent: 3, name: "Kuwaiti Dinar" },
];

async function main(): Promise<void> {
  for (const currency of CURRENCIES) {
    await prisma.currency.upsert({
      where: { code: currency.code },
      create: currency,
      update: { exponent: currency.exponent, name: currency.name },
    });
  }
  // eslint-disable-next-line no-console
  console.log(`Seeded ${CURRENCIES.length} currencies.`);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
