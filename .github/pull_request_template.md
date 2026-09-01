<!--
  ADR-058. This template exists because a session report is the evidence the Founder reviews
  everything except money and access code on. IMPLEMENTATION_PLAN's Definition of Done already
  requires the distinction below between what was RUN and what was merely written; the template is
  where that requirement stops depending on anyone remembering it.

  Delete a section only if it is genuinely empty — "none" is an answer, an absent heading is not.
-->

## Business value

<!-- What customer problem is smaller after this merges? One or two sentences. -->

## Architecture & trade-offs

<!--
  Why this shape and not the obvious alternative. Name the alternative and why it was rejected —
  on its weakness, not on effort. If this touches a decision an ADR already made, cite it.
-->

## What was RUN vs. what was written but not run

<!--
  The section this template was created for.

  RUN — commands and their actual results, not "tests pass":
    pnpm run lint          -> clean
    pnpm run typecheck     -> clean
    pnpm run build         -> clean
    pnpm run test          -> N files, M tests, all passing
    <any live check against production, with the real status codes and rows>

  FALSIFICATION — for any new check, guard or invariant: break it, show it failing, restore it,
  show it passing. A claim of "falsified" with no result is a claim, not evidence.

  NOT RUN — say so plainly, and why. Missing credentials, no staging target, requires a browser
  the harness does not have. An honest "written but not run, here is exactly what is unverified"
  is a complete answer; silence is not.
-->

## Docs touched and version bumps

<!--
  Every docs/*.md this PR changes, with its old -> new version.
  `repo-invariants.spec.ts` (ADR-056) fails if a changed document's version did not move, so this
  section should already agree with a green CI run. If nothing under docs/ changed, say "none".
-->

## CI status of the head commit

<!--
  The result of the run, not the fact of the push. A commit hash is not a green check.
  Paste the conclusion per check, e.g.:
    lint-typecheck-test-build  pass  2m09s
    browser-e2e                pass  2m13s
-->

## Known limitations

<!--
  What this deliberately does not do, and what is left open. If a finding was recorded rather than
  fixed, name it and where it is recorded (THREAT_MODEL, an ADR, IMPLEMENTATION_PLAN).
-->
