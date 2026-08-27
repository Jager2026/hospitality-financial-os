import { en, type MessageKey } from "./en";

/**
 * ADR-040 — the Portal ships in English only, and every string goes through here anyway.
 *
 * The typing does the enforcing rather than a convention:
 *   - `t()` only accepts a `MessageKey`, so a mistyped key fails to compile rather than
 *     rendering a raw key at a customer.
 *   - `Dictionary` is `Record<MessageKey, string>`, so a second language cannot be added
 *     half-finished. Lithuanian arrives complete or not at all — which matters because the
 *     trigger for adding it (ADR-040) is a native speaker translating, not us.
 *
 * No interpolation, no plural rules, no formatter here yet. Money formatting is locale-driven
 * and belongs to the money helper (DESIGN_SYSTEM.md, Money formatting), not to this file — an
 * amount is never a translated string.
 */
export type Dictionary = Record<MessageKey, string>;

export type Locale = "en";

export const DEFAULT_LOCALE: Locale = "en";

const dictionaries: Record<Locale, Dictionary> = { en };

export function getDictionary(locale: Locale = DEFAULT_LOCALE): Dictionary {
  return dictionaries[locale];
}

/** Look up one message. The key is checked at compile time; there is no runtime fallback path
 * because there is no way to reach this function with a key that does not exist. */
export function t(key: MessageKey, locale: Locale = DEFAULT_LOCALE): string {
  return dictionaries[locale][key];
}

export type { MessageKey };
