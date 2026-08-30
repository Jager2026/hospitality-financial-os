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

  // The fixture rule, as a check rather than a habit.
  //
  // What is forbidden is narrower than "a literal", and the narrowness is the point. A synthetic
  // caller holding one permission is legitimate — many tests exist precisely to show that one is
  // not enough, and swapping in the real seven-permission Manager would destroy the discrimination
  // they were written for. A fixture naming the Waiter and giving it an empty permission array is
  // a literal and is *correct*, because the seeded Waiter really holds none.
  //
  // What is forbidden is a fixture NAMING a seeded Role and then describing permissions the seed
  // does not give it. That is what actually happened: an "Owner" with two of its ten Permissions,
  // and later one with none at all — fixtures proving things about a system that does not exist,
  // believable precisely because of the name.
  //
  // No allowlist, by construction: a synthetic caller simply must not carry a real Role's name,
  // and `syntheticCaller()` refuses one at runtime too.
  it("keeps seeded Role names out of hand-written permission fixtures", () => {
    const SRC = join(REPO_ROOT, "apps", "backend", "src");
    const SEEDED = ["Owner", "Administrator", "Manager", "Waiter"];

    function walk(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.name.endsWith(".spec.ts") ? [full] : [];
      });
    }

    // Collapsed to one line so a fixture split across lines is caught the same as an inline one;
    // `[^}]*` keeps the match inside a single object literal rather than spanning unrelated code.
    const named = SEEDED.join("|");
    const patterns = [
      new RegExp(`name:\\s*"(?:${named})"[^}]*permissions:\\s*\\[`),
      new RegExp(`permissions:\\s*\\[[^}]*name:\\s*"(?:${named})"`),
    ];

    const offenders = walk(SRC)
      .filter((file) => {
        const collapsed = readFileSync(file, "utf8").replace(/\s+/g, " ");
        return patterns.some((p) => p.test(collapsed));
      })
      .map((file) => relative(REPO_ROOT, file));

    expect(
      offenders,
      `A fixture naming a seeded Role must take its permissions from the seed — use ` +
        `callerWithSeededRole() from test/fixtures/authenticated-user.ts. If the test genuinely ` +
        `needs a narrow permission set, use syntheticCaller(), which must not wear a real Role's ` +
        `name. Offending files:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
