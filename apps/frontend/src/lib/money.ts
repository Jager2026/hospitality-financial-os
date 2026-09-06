/**
 * Minor units to something a person reads, in the locale that owns the amount.
 *
 * **The API sends money as a decimal string of MINOR units** — `"1250"` is €12.50 — because
 * ADR-001 keeps money in BIGINT minor units end to end and JSON has no integer wide enough to be
 * trusted with it. The string arrives here and must not become a `number` on the way to the
 * screen: `parseFloat` on a large amount is exactly the floating-point arithmetic that ADR forbids,
 * and it would be invisible until a venue was big enough for it to matter.
 *
 * **The locale is not a decoration, and hardcoding one was a real defect.** DESIGN_SYSTEM.md is
 * explicit: *"Locale-driven, from the Restaurant's own locale, never hardcoded … `1 240,00 €` in
 * `lt-LT`, `€1,240.00` in `en-*`."* The first version of this file wrote `en-IE` into the default
 * parameter, so a Lithuanian owner read American-shaped money on their own dashboard — the first
 * thing they would notice, and something no test could see because every test asserted the string
 * the code produced.
 *
 * **How it stays exact while still following the locale.** `Intl` is asked to format ZERO, which
 * yields the locale's skeleton — where the symbol sits, which separator it uses, whether a space
 * comes between. The digits are then substituted in from the string itself. Nothing is parsed,
 * nothing is rounded, and a symbol that belongs after the amount lands after it.
 */

/** Currencies this Portal formats. EUR alone today (ADR-012); the map is what a second one edits. */
const MINOR_UNIT_DIGITS: Record<string, number> = { EUR: 2 };

const DEFAULT_DIGITS = 2;

/**
 * `"1250"`, `"EUR"`, `"lt-LT"` -> `"12,50 €"`.
 * `"1250"`, `"EUR"`, `"en-IE"` -> `"€12.50"`.
 */
export function formatMoney(minorUnits: string, currency: string, locale: string): string {
  const digits = MINOR_UNIT_DIGITS[currency] ?? DEFAULT_DIGITS;
  const negative = minorUnits.trim().startsWith("-");
  const raw = minorUnits.replace(/\D/g, "") || "0";

  const padded = raw.padStart(digits + 1, "0");
  const whole = padded.slice(0, padded.length - digits);
  const fraction = digits === 0 ? "" : padded.slice(padded.length - digits);

  // Exact: BigInt in, grouped string out. This is the only place the whole part is touched.
  const groupedWhole = new Intl.NumberFormat(locale).format(BigInt(whole));

  // The locale's own arrangement, learned from a value with no grouping so there is exactly one
  // integer part to substitute.
  const skeleton = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    currencyDisplay: "narrowSymbol",
  }).formatToParts(0);

  const body = skeleton
    .map((part) => {
      if (part.type === "integer") return groupedWhole;
      if (part.type === "fraction") return fraction;
      if (part.type === "minusSign") return "";
      return part.value;
    })
    .join("");

  return negative ? `−${body}` : body;
}

/** Basis points as a percentage: `"1250"` -> `"12.5%"`. Same rule — the string is cut, not parsed. */
export function formatBasisPoints(basisPoints: string, locale: string): string {
  const negative = basisPoints.trim().startsWith("-");
  const raw = basisPoints.replace(/\D/g, "") || "0";
  const padded = raw.padStart(3, "0");
  const whole = padded.slice(0, padded.length - 2);
  const fraction = padded.slice(padded.length - 2).replace(/0+$/, "");

  const decimal =
    new Intl.NumberFormat(locale).formatToParts(1.1).find((p) => p.type === "decimal")?.value ??
    ".";
  const groupedWhole = new Intl.NumberFormat(locale).format(BigInt(whole));
  const body = fraction === "" ? groupedWhole : `${groupedWhole}${decimal}${fraction}`;
  return `${negative ? "−" : ""}${body}%`;
}

/**
 * The locale an amount is WRITTEN in, which is the venue's, not the reader's.
 *
 * `1 240,00 €` is a numeric convention rather than a translation: a Lithuanian business writes its
 * takings that way whoever is looking at the screen. The reader's language is a separate question,
 * and ADR-040 already answers it — the Portal is English. Keeping the two apart is what stops a
 * later "fix" from rendering weekday names in Lithuanian on an otherwise English screen.
 *
 * Built from the Restaurant's own two fields. `defaultCustomerLocale` is documented as describing
 * the venue's diners rather than its staff, which is exactly right here: it is being used for how
 * the venue's own money is written, not for what language anybody reads.
 */
export function venueMoneyLocale(
  defaultCustomerLocale: string | null | undefined,
  country: string | null | undefined,
): string {
  const language = (defaultCustomerLocale ?? "").trim();
  const region = (country ?? "").trim().toUpperCase();
  if (language === "") return region === "" ? "en" : `en-${region}`;
  return region === "" ? language : `${language}-${region}`;
}
