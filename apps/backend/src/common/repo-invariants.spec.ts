import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Repository-level invariants — deliberately not about the backend.
 *
 * They live in this suite because it is the one that already runs on every pull request; a root
 * vitest project created to hold a single assertion would be more machinery than the problem
 * deserves. The file name says the scope out loud so nobody looks for backend behaviour in here.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

describe("repository invariants", () => {
  it("keeps CLAUDE.md and docs/CLAUDE_RULES.md byte-identical (ADR-011)", () => {
    // ADR-011 made the root CLAUDE.md — the file Claude actually loads — and the versioned
    // docs/CLAUDE_RULES.md one document in two locations. Nothing enforced it, and it drifted:
    // a header rewrite in PR #70 prepended a new frontmatter block to the docs copy instead of
    // editing it, leaving a stale `version: 2.4.2` block behind in both files and two different
    // versions claimed by two files asserted to be the same one.
    //
    // The drift was invisible for four PRs because the bodies stayed identical — the rules Claude
    // reads were never actually wrong. That is precisely why this needs a check rather than care:
    // the failure mode of a duplicated document is not that it breaks loudly, it is that the two
    // copies answer the same question differently and nobody is looking at both.
    const root = readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf8");
    const docs = readFileSync(join(REPO_ROOT, "docs", "CLAUDE_RULES.md"), "utf8");

    expect(docs).toBe(root);
  });
});
