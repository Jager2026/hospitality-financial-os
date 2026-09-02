#!/usr/bin/env node
// @ts-check
// ADR-060. `docs/INDEX.md` is the register of every document and its version. It used to carry a
// `version:` of its own, and that one line was the site of five consecutive merge conflicts —
// #118 through #130 — not one of which was about content: every branch bumped the same number
// from the same base. The line is gone. What replaces it is this check, which is the thing the
// version was supposed to stand for: that the register agrees with what it registers.
//
// Two directions, because a one-directional check passes for the wrong reason:
//   1. every `docs/*.md` that declares a `version:` has an INDEX row, and the row's version is
//      the document's — a document that bumped without its row moving is the drift ADR-056's
//      invariant exists to prevent, and the row is where a reader looks first;
//   2. every INDEX row that names a `docs/*.md` file points at a file that exists — a row for a
//      deleted or renamed document is a register lying about its own contents.
//
// Deliberately NOT covered, stated so nobody patches it in by reflex: the prose description in
// each row. It is hand-written and stays hand-written (ADR-060); nothing can check it but a
// reader. This script checks the number, which is the only part a machine can be right about.
//
// This was a shell loop run by hand at the end of every documentation PR for several sprints.
// A check that lives in a session's habit is a check that stops the day the habit does — the
// same class as the permission matrix in test/global-setup.ts and the 914-rule allow list
// (ADR-058). Moving it here is the whole change.
const { readFileSync, readdirSync, existsSync } = require("node:fs");
const { join, resolve } = require("node:path");

const ROOT = resolve(__dirname, "..", "..");
const DOCS = join(ROOT, "docs");
const INDEX = join(DOCS, "INDEX.md");

/** @param {string} text @returns {string | null} */
function frontmatterVersion(text) {
  // Frontmatter is the leading `---` block only. A `version:` anywhere else in a document —
  // quoted, discussed, in an ADR's table — must not count, or the check reads the wrong number.
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return null;
  const m = /^version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$/m.exec(text.slice(4, end));
  return m ? m[1] : null;
}

/** @returns {Map<string, string>} link target -> version as written in the row */
function indexRows() {
  const rows = new Map();
  for (const line of readFileSync(INDEX, "utf8").split("\n")) {
    // `| [NAME.md](NAME.md) | 1.2.3 | …` — the link TARGET is the identity; the link text may
    // carry a title annotation (API_Contract.md's row does).
    const m = /^\|\s*\[[^\]]+\]\(([^)]+\.md)\)[^|]*\|\s*([^|]+?)\s*\|/.exec(line);
    if (m) rows.set(m[1], m[2]);
  }
  return rows;
}

const rows = indexRows();
/** @type {string[]} */
const problems = [];

// Direction 1: every versioned document is registered at its own version.
for (const name of readdirSync(DOCS).filter((f) => f.endsWith(".md") && f !== "INDEX.md")) {
  const version = frontmatterVersion(readFileSync(join(DOCS, name), "utf8"));
  if (version === null) continue; // unversioned documents (mermaid sources) are not the register's job
  const registered = rows.get(name);
  if (registered === undefined) {
    problems.push(`${name}: frontmatter version ${version}, but INDEX.md has no row for it`);
  } else if (registered !== version) {
    problems.push(`${name}: frontmatter version ${version}, INDEX.md row says ${registered}`);
  }
}

// Direction 2: every registered file exists.
for (const target of rows.keys()) {
  if (!existsSync(join(DOCS, target))) {
    problems.push(`INDEX.md row points at docs/${target}, which does not exist`);
  }
}

if (problems.length > 0) {
  console.error(`docs/INDEX.md disagrees with the documents it registers (${problems.length}):`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "\nFix the row or the frontmatter so they say the same thing. The row's version is the number a" +
      " reader trusts; the frontmatter's is the one ADR-056's invariant checks. They must be one number.",
  );
  process.exit(1);
}

console.log(`docs/INDEX.md agrees with ${rows.size} registered documents.`);
