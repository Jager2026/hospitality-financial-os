// @ts-check
/**
 * The decision half of the CI dependency-vulnerability gate, kept separate from the half that
 * shells out to `pnpm audit`.
 *
 * Split for one reason: this file has no side effects, so a test can import it. `check-audit.js`
 * runs its audit at module load, which means importing *that* to test it would run a real audit —
 * slow, network-dependent, and dependent on whatever the advisory database says today.
 *
 * The split is not a general "extract for testability" reflex. It exists because the logic below
 * is what gets edited under pressure: someone adds a GHSA id to the ignore list at the end of a
 * long day, and nothing else in this repository would notice if the filtering silently stopped
 * distinguishing ignored from unignored.
 */

/**
 * Thrown when the audit could not be evaluated at all, as opposed to evaluating to "no
 * vulnerabilities". The distinction is the whole point of this module: **a gate that could not run
 * its check must say so, never report success.**
 */
class AuditUnavailableError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "AuditUnavailableError";
  }
}

/**
 * @param {unknown} report parsed `pnpm audit --json` output
 * @param {Record<string, string>} ignored GHSA id -> justification
 * @returns {{ unignored: any[]; ignoredFound: any[] }}
 * @throws {AuditUnavailableError} when the report is not a shape this gate understands
 */
function evaluate(report, ignored) {
  if (typeof report !== "object" || report === null) {
    throw new AuditUnavailableError(`audit report is ${report === null ? "null" : typeof report}`);
  }

  // A clean run still carries `advisories: {}` alongside `actions`, `muted` and `metadata` —
  // verified against the real command on the pinned pnpm, not assumed. So a MISSING `advisories`
  // key is not an empty result; it means this is not the output we know how to read, and the
  // honest answer is "could not check" rather than "nothing found". This is the one guard here
  // that would survive pnpm changing its output format.
  if (!("advisories" in report)) {
    throw new AuditUnavailableError(
      `audit report has no "advisories" key (saw: ${Object.keys(report).join(", ") || "no keys"})`,
    );
  }

  const advisoriesValue = /** @type {{ advisories: unknown }} */ (report).advisories;
  if (typeof advisoriesValue !== "object" || advisoriesValue === null) {
    throw new AuditUnavailableError(
      `"advisories" is ${typeof advisoriesValue}, expected an object`,
    );
  }

  const advisories = Object.values(advisoriesValue);
  const blocking = (/** @type {any} */ a) => ["high", "critical"].includes(a.severity);

  return {
    unignored: advisories.filter((a) => blocking(a) && !(a.github_advisory_id in ignored)),
    ignoredFound: advisories.filter((a) => blocking(a) && a.github_advisory_id in ignored),
  };
}

module.exports = { evaluate, AuditUnavailableError };
