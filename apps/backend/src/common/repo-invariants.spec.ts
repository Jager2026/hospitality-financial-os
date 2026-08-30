import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
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

  // The mechanism against recurrence, required before the consolidation was allowed to land.
  //
  // The count went from three to thirteen without anyone deciding to widen it: each new module
  // simply wrote the predicate inline, and the utility's own comment went on describing a bound
  // that had stopped being true. Consolidating without a check would reset the counter and leave
  // the same drift free to happen again — and this predicate has already shipped wrong three
  // times (RestaurantService.findAllForUser, TipService.assertReachable, and the
  // cross-Organization leak in MembershipService).
  //
  // Deliberately NOT an allowlist. The three legitimate nullable-target sites
  // (MembershipService ×2, WalletService) compare against a Membership's or Wallet's
  // organizationId, never a Restaurant's, so this pattern excludes them **by construction**. An
  // allowlist would be a file someone edits to make the build green — the rubber-stamp
  // degradation CLAUDE.md names, and the reason that shape was rejected twice already this sprint.
  it("keeps the restaurant reachability predicate out of every call site (one implementation, not thirteen)", () => {
    const SRC = join(REPO_ROOT, "apps", "backend", "src");
    const UTIL = join(SRC, "common", "restaurant-reachability.util.ts");
    const PREDICATE = "m.organizationId === restaurant.organizationId";

    function walk(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".spec.ts")) return [];
        return [full];
      });
    }

    const offenders = walk(SRC)
      .filter((file) => file !== UTIL)
      .filter((file) => readFileSync(file, "utf8").includes(PREDICATE))
      .map((file) => relative(REPO_ROOT, file));

    expect(
      offenders,
      `Use isRestaurantReachable/hasPermissionAtRestaurant/findGrantingMembership from restaurant-reachability.util.ts instead of writing the predicate inline. Offending files:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
