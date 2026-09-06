/**
 * Minor units to something a person reads.
 *
 * **The API sends money as a decimal string of MINOR units** — `"1250"` is €12.50 — because
 * ADR-001 keeps money in BIGINT minor units end to end and JSON has no integer wide enough to be
 * trusted with it. The string arrives here and must not become a `number` on the way to the
 * screen: `parseFloat` on a large amount is exactly the floating-point arithmetic that ADR forbids,
 * and it would be invisible until a venue was big enough for it to matter.
 *
 * So the split is done on the string itself. No arithmetic, no rounding, nothing to get wrong at
 * scale — the value is only ever cut into two parts and reassembled.
 */

/** Currencies this Portal formats. EUR alone today (ADR-012); the map is what a second one edits. */
const MINOR_UNIT_DIGITS: Record<string, number> = { EUR: 2 };

const DEFAULT_DIGITS = 2;

/**
 * `"1250"`, `"EUR"` -> `"€12.50"`.
 *
 * Rendered with `Intl.NumberFormat` so the separators follow the locale rather than a template —
 * but the NUMBER handed to it is built from the string's own digits, never parsed out of it.
 */
export function formatMoney(minorUnits: string, currency: string, locale = "en-IE"): string {
  const digits = MINOR_UNIT_DIGITS[currency] ?? DEFAULT_DIGITS;
  const negative = minorUnits.startsWith("-");
  const raw = (negative ? minorUnits.slice(1) : minorUnits).replace(/\D/g, "") || "0";

  const padded = raw.padStart(digits + 1, "0");
  const whole = padded.slice(0, padded.length - digits);
  const fraction = digits === 0 ? "" : padded.slice(padded.length - digits);

  const groupedWhole = new Intl.NumberFormat(locale).format(BigInt(whole));
  const decimalSeparator = separatorFor(locale);
  const body = digits === 0 ? groupedWhole : `${groupedWhole}${decimalSeparator}${fraction}`;

  const symbol = symbolFor(currency, locale);
  return `${negative ? "−" : ""}${symbol}${body}`;
}

/** Basis points as a percentage: `"1250"` -> `"12.5%"`. Same rule — the string is cut, not parsed. */
export function formatBasisPoints(basisPoints: string): string {
  const negative = basisPoints.startsWith("-");
  const raw = (negative ? basisPoints.slice(1) : basisPoints).replace(/\D/g, "") || "0";
  const padded = raw.padStart(3, "0");
  const whole = padded.slice(0, padded.length - 2);
  const fraction = padded.slice(padded.length - 2).replace(/0+$/, "");
  return `${negative ? "−" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}%`;
}

function separatorFor(locale: string): string {
  const parts = new Intl.NumberFormat(locale).formatToParts(1.1);
  return parts.find((p) => p.type === "decimal")?.value ?? ".";
}

function symbolFor(currency: string, locale: string): string {
  const parts = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
  }).formatToParts(0);
  return parts.find((p) => p.type === "currency")?.value ?? `${currency} `;
}
