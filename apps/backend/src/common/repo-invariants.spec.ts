import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REDACTED_USER_STRING_FIELDS,
  RETAINED_USER_STRING_FIELDS,
} from "../user-redaction/redact-user";

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

  // Every route the backend guards must say so in the contract the frontend codes against.
  //
  // Before this existed, three of thirteen guarded routes mentioned their Permission and ten did
  // not — and the format had no place for it, so a reader could not distinguish "needs none" from
  // "nobody wrote it down". That mattered most exactly where the answer is least guessable: each
  // `/export` variant requires `data.export` rather than its sibling's `reports.view` (ADR-027).
  //
  // The parser below associates a permission with the route decorator ABOVE it, which is the order
  // the code actually uses. An earlier version of this scan read it the other way round and
  // reported eight phantom mismatches — a reminder that a checker fails by *finding* something,
  // which is what an audit is looking for. It is falsified in both directions before being trusted.
  it("states every guarded route's required permission in API_Contract.md", () => {
    const SRC = join(REPO_ROOT, "apps", "backend", "src");
    const contract = readFileSync(join(REPO_ROOT, "docs", "API_Contract.md"), "utf8").split("\n");

    function controllers(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return controllers(full);
        return entry.name.endsWith(".controller.ts") ? [full] : [];
      });
    }

    const guarded: Array<{ method: string; path: string; permission: string }> = [];
    for (const file of controllers(SRC)) {
      const text = readFileSync(file, "utf8");
      const prefix = text.match(/@Controller\("([^"]*)"\)/)?.[1] ?? "";
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        const verb = line.match(/@(Get|Post|Patch|Put|Delete)\(\s*(?:"([^"]*)")?\s*\)/);
        if (!verb) return;
        let permission: string | null = null;
        for (let j = i + 1; j < lines.length; j += 1) {
          if (/@(Get|Post|Patch|Put|Delete)\(/.test(lines[j])) break;
          const required = lines[j].match(/@RequirePermission\("([^"]+)"\)/);
          if (required) {
            permission = required[1];
            break;
          }
          if (/^\s{2}[a-zA-Z]\w*[(<]/.test(lines[j])) break; // handler signature
        }
        if (!permission) return;
        const path = `/${[prefix, verb[2] ?? ""].filter(Boolean).join("/")}`.replace(
          /:(\w+)/g,
          "{$1}",
        );
        guarded.push({ method: verb[1].toUpperCase(), path, permission });
      });
    }

    // A route is "stated" when its Permission appears in the block that documents it. Two
    // normalisations, both learned by getting this wrong first.
    //
    // Parameter NAMES differ between the contract and the code — the contract writes
    // `/organizations/{id}/restaurants` where the controller declares `:organizationId`. A naming
    // inconsistency worth its own fix, not a different route, so both sides collapse to `{}`.
    //
    // And the anchor must end at a route boundary: a prefix match let `GET /transactions` anchor on
    // `GET /transactions/{id}/refunds`, sixty lines from the route actually being checked.
    // Query strings are dropped too: the contract documents `GET /dashboard?restaurantId={id}`,
    // the controller declares the path alone, and they are the same route.
    const shape = (route: string) => route.split("?")[0].replace(/\{[^}]*\}/g, "{}");
    const missing = guarded
      .filter(({ method, path, permission }) => {
        const wanted = `${method} ${shape(path)}`;
        const start = contract.findIndex((line) => {
          const m = line.trim().match(/^([A-Z]+) (\/\S*)/);
          return m ? `${m[1]} ${shape(m[2])}` === wanted : false;
        });
        if (start === -1) return true;
        return !contract
          .slice(start, start + 6)
          .join("\n")
          .includes(permission);
      })
      .map(({ method, path, permission }) => `${method} ${path} — needs "${permission}"`);

    expect(
      missing,
      `API_Contract.md must state the Permission every guarded route requires, as a \`Requires:\` ` +
        `line under the route. Not stated:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  // The boundary PERSONAL_DATA_MAP.md found, kept where it is.
  //
  // Money is attributed to a `Membership`, never to a `User` — `Payment.waiterMembershipId`,
  // `LedgerLine.membershipId`, `Wallet.membershipId`, `Adjustment.membershipId`. A Membership id
  // carries no name, no email, no contact detail: it is already a pseudonym. That is why a person's
  // identifying fields can be emptied without touching a single monetary figure, and why the
  // apparent conflict between erasure and the Ledger is not a real one.
  //
  // Nothing stated that as a rule; the schema simply happened to be built this way from the start.
  // One migration attaching `userId` to any of these models would make the conflict real, silently,
  // and the person who wrote it would have no reason to think they had done anything unusual.
  //
  // What is forbidden is narrow, deliberately: attributing a monetary AMOUNT to a person. Recording
  // an ACTOR is fine and already happens — `Refund.requestedBy`, `Refund.approvedBy` and
  // `Adjustment.createdBy` all reference a User, because "who asked for this" is not "whose money
  // this is". Those three are why the check names four models rather than forbidding `userId`
  // everywhere in the financial half of the schema.
  it("keeps money attributed to a Membership, never to a User (the pseudonym boundary)", () => {
    const schema = readFileSync(
      join(REPO_ROOT, "apps", "backend", "prisma", "schema.prisma"),
      "utf8",
    );
    const ATTRIBUTION_MODELS = ["Payment", "LedgerLine", "Wallet", "Adjustment"];

    const offenders = ATTRIBUTION_MODELS.filter((model) => {
      const start = schema.indexOf(`model ${model} {`);
      if (start === -1) return false; // a renamed model is a different failure, not this one
      const body = schema.slice(start, schema.indexOf("\n}", start));
      // A field literally named `userId` — the shape someone reaches for when attributing money
      // to a person directly.
      //
      // The limit is stated rather than papered over: this does NOT catch a User relation given
      // some other name. The first draft tried, by forbidding any mention of `User` in the model
      // body, and immediately flagged `Adjustment.createdByUser` — an actor field the paragraph
      // above explicitly allows. A check that contradicts its own stated rule is worse than a
      // narrower one, so this catches the realistic mistake and says what it misses.
      return /\buserId\b/.test(body);
    });

    expect(
      offenders,
      `Money is attributed to a Membership, never to a User — see PERSONAL_DATA_MAP.md §2. A ` +
        `Membership id is already a pseudonym, which is what lets a person's identifying fields be ` +
        `emptied without touching any monetary figure. Linking one of these models to a User makes ` +
        `erasure and the Ledger genuinely conflict. Recording an ACTOR (who requested a refund, who ` +
        `created an adjustment) is a different thing and stays allowed. Offending models:\n` +
        offenders.join("\n"),
    ).toEqual([]);

    // The other half of the pair: the boundary is only meaningful while these models actually
    // attribute to a Membership. If one stopped, the check above would pass vacuously.
    const missingAttribution = ATTRIBUTION_MODELS.filter((model) => {
      const start = schema.indexOf(`model ${model} {`);
      if (start === -1) return true;
      const body = schema.slice(start, schema.indexOf("\n}", start));
      return !/membershipId/i.test(body) && !/waiterMembershipId/i.test(body);
    });

    expect(
      missingAttribution,
      `These models are expected to attribute to a Membership; if that changed, the boundary check ` +
        `above is passing for the wrong reason:\n${missingAttribution.join("\n")}`,
    ).toEqual([]);
  });

  // The other half of the typed audit metadata. Without this, `AuditMetadata` is advice rather
  // than a constraint: Prisma's `Json?` column accepts any object handed to it directly, so one
  // `prisma.auditLog.create({ data: { metadata: req.body } })` would reopen the whole question.
  //
  // PERSONAL_DATA_MAP.md §3 named `metadata` as the single field where personal data can
  // accumulate with nobody deciding that it should. A closed type answers that only while every
  // write goes through it.
  it("writes AuditLog rows through the typed helper alone", () => {
    const SRC = join(REPO_ROOT, "apps", "backend", "src");
    const HELPER = join(SRC, "common", "audit", "audit-metadata.ts");

    function walk(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".spec.ts")) return [];
        return [full];
      });
    }

    const offenders = walk(SRC)
      .filter((file) => file !== HELPER)
      .filter((file) => /auditLog\s*\.\s*create/.test(readFileSync(file, "utf8")))
      .map((file) => relative(REPO_ROOT, file));

    expect(
      offenders,
      `Write audit rows with writeAuditLog() from common/audit/audit-metadata.ts, whose ` +
        `AuditMetadata type is what keeps personal data out of the metadata column. Calling ` +
        `prisma.auditLog.create directly bypasses it. Offending files:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  // ADR-052. The erasure mechanism must stay unreachable over HTTP: a route that empties a user is
  // the most dangerous thing this codebase could expose, and a subject-rights request at this scale
  // is a manual, verified act. "It is not a Nest provider" is a property of today's code, not a
  // rule, until something checks it — and the edit that would break it (injecting a helper into a
  // service that a controller already uses) looks entirely ordinary in review.
  it("keeps the user-redaction mechanism out of every HTTP surface (ADR-052)", () => {
    const backendSrc = join(REPO_ROOT, "apps", "backend", "src");
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(controller|module)\.ts$/.test(entry.name)) continue;
        if (readFileSync(full, "utf8").includes("user-redaction")) {
          offenders.push(relative(REPO_ROOT, full));
        }
      }
    };
    walk(backendSrc);

    expect(
      offenders,
      `user-redaction must never be reachable from a controller or wired into a module. It is a ` +
        `script-only mechanism (apps/backend/scripts/redact-user.ts). Offending files:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  // ADR-052. The redaction lists are a claim about every String field on User, and nothing
  // re-checks that claim when a column is added. A new `phoneNumber String` would be silently
  // retained by an erasure routine that believes it is complete — the failure would be invisible
  // exactly because the code still compiles and every existing test still passes.
  it("classifies every String field on User as redacted or retained (ADR-052)", () => {
    const schema = readFileSync(
      join(REPO_ROOT, "apps", "backend", "prisma", "schema.prisma"),
      "utf8",
    );
    const model = /^model User \{$([\s\S]*?)^\}$/m.exec(schema);
    expect(model, "could not locate the User model in schema.prisma").not.toBeNull();

    const stringFields = (model![1].split("\n") as string[])
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("//") && !line.startsWith("@@"))
      .map((line) => /^(\w+)\s+String(\?)?(\s|$)/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => m[1]);

    // Non-vacuity: if the parse silently matched nothing, every assertion below would pass.
    expect(stringFields).toContain("email");
    expect(stringFields.length).toBeGreaterThanOrEqual(4);

    const classified = new Set<string>([
      ...REDACTED_USER_STRING_FIELDS,
      ...RETAINED_USER_STRING_FIELDS,
    ]);
    const unclassified = stringFields.filter((f) => !classified.has(f));

    expect(
      unclassified,
      `New String field(s) on User are classified by neither list in ` +
        `src/user-redaction/redact-user.ts. Decide for each whether an erasure request must clear ` +
        `it, and add it to REDACTED_USER_STRING_FIELDS or RETAINED_USER_STRING_FIELDS with the ` +
        `reason. Unclassified:\n${unclassified.join("\n")}`,
    ).toEqual([]);
  });
});
