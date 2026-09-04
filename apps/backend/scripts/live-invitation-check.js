#!/usr/bin/env node
/**
 * The live verification of ADR-070: send ONE real invitation through the production API and report
 * exactly what to look for in the mailbox.
 *
 * WHY A SCRIPT AND NOT A CURL ONE-LINER. The check needs four calls in order, each depending on the
 * last, and the interesting failures are in between — no restaurant, no assignable Role, a login
 * that works but a permission that does not. A one-liner reports the last status code; this reports
 * which step failed and what that means.
 *
 * THE PASSWORD IS NEVER AN ARGUMENT. It is read from the terminal with echo off, so it does not
 * reach shell history, the process list, or any log. It is used once, for the login call, and is
 * never written anywhere.
 *
 * CREATING A RESTAURANT IS A SEPARATE, EXPLICIT ACT. Production currently has users but no
 * Organization and no Restaurant, and an invitation is scoped to an Organization — so the check
 * cannot run without one. Rather than quietly creating a company record as a side effect of a mail
 * test, this refuses and asks for `--create-restaurant`. Real business data in production should be
 * created because someone decided to, not because a script needed something to exist.
 *
 * Usage:
 *   node apps/backend/scripts/live-invitation-check.js \
 *     --inviter you@example.com --to someone@example.com [--create-restaurant]
 */

const readline = require("node:readline");

const API = arg("api") || "https://api.plaintabs.com";
const INVITER = arg("inviter");
const TO = arg("to");
const CREATE_RESTAURANT = process.argv.includes("--create-restaurant");

/** Edit these before using --create-restaurant. They become a real Restaurant in production. */
const NEW_RESTAURANT = {
  name: "PlainTabs Pilot",
  legalName: "PlainTabs UAB",
  companyNumber: "000000000",
  vatNumber: "LT000000000",
  email: "hello@plaintabs.com",
  phone: "+37060000000",
  country: "LT",
  currency: "EUR",
  timezone: "Europe/Vilnius",
  address: "Vilnius, Lithuania",
};

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

function fail(step, message) {
  console.error(`\n  STOPPED at ${step}:\n  ${message}\n`);
  process.exit(2);
}

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onData = (char) => {
      if (["\n", "\r", ""].includes(String(char))) {
        process.stdin.removeListener("data", onData);
      } else {
        // Repaint the prompt without the typed characters.
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(prompt);
      }
    };
    process.stdin.on("data", onData);
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* left null on purpose — the caller reports the raw text */
  }
  return { status: res.status, json, text };
}

async function main() {
  if (!INVITER || !TO) {
    fail("arguments", "--inviter and --to are both required.");
  }

  console.log(`\n  API:      ${API}`);
  console.log(`  Inviter:  ${INVITER}`);
  console.log(`  Recipient: ${TO}\n`);

  const password = await askHidden("  Password (not echoed, not stored): ");
  if (!password) fail("password", "no password entered.");

  // 1. Log in.
  const login = await call("POST", "/auth/login", { body: { email: INVITER, password } });
  if (login.status !== 200 && login.status !== 201) {
    fail("login", `HTTP ${login.status}. ${login.text.slice(0, 300)}`);
  }
  const token = login.json?.data?.accessToken ?? login.json?.accessToken;
  if (!token) fail("login", `no accessToken in the response: ${login.text.slice(0, 300)}`);
  console.log("  1/4  Logged in.");

  // 2. Find a Restaurant, or create one — but only when told to.
  const list = await call("GET", "/restaurants", { token });
  if (list.status !== 200) fail("restaurants", `HTTP ${list.status}. ${list.text.slice(0, 300)}`);
  let restaurants = list.json?.data ?? list.json ?? [];
  if (Array.isArray(restaurants.data)) restaurants = restaurants.data;

  let restaurantId = restaurants[0]?.id ?? null;
  if (!restaurantId) {
    if (!CREATE_RESTAURANT) {
      fail(
        "restaurants",
        "this account reaches no Restaurant, and an invitation is scoped to an Organization.\n" +
          "  Nothing was created. Re-run with --create-restaurant to create one — and read the\n" +
          "  NEW_RESTAURANT constant at the top of this file first: it becomes real production data.",
      );
    }
    console.log(
      `  2/4  No Restaurant found. Creating "${NEW_RESTAURANT.name}" (--create-restaurant).`,
    );
    const created = await call("POST", "/restaurants", { token, body: NEW_RESTAURANT });
    if (created.status !== 201 && created.status !== 200) {
      fail("create restaurant", `HTTP ${created.status}. ${created.text.slice(0, 400)}`);
    }
    restaurantId = created.json?.data?.id ?? created.json?.id;
    if (!restaurantId) fail("create restaurant", `no id returned: ${created.text.slice(0, 300)}`);
  }
  console.log(`  2/4  Restaurant: ${restaurantId}`);

  // 3. Find the Waiter Role.
  const roles = await call("GET", "/roles", { token });
  if (roles.status !== 200) fail("roles", `HTTP ${roles.status}. ${roles.text.slice(0, 300)}`);
  const roleList = roles.json?.data ?? roles.json ?? [];
  const waiter = roleList.find?.((r) => r.name === "Waiter");
  if (!waiter) {
    fail("roles", `no assignable "Waiter" Role. Roles seen: ${roleList.map?.((r) => r.name)}`);
  }
  console.log(`  3/4  Role: Waiter (${waiter.id})`);

  // 4. The invitation itself — this is what sends the email.
  const invite = await call("POST", "/memberships", {
    token,
    body: { email: TO, restaurantId, roleId: waiter.id },
  });
  if (invite.status !== 201 && invite.status !== 200) {
    fail("invite", `HTTP ${invite.status}. ${invite.text.slice(0, 400)}`);
  }
  const invitation = invite.json?.data ?? invite.json;
  console.log(`  4/4  Invitation created: ${invitation?.id}`);

  // ADR-070's own assertion, checked live rather than only in the suite.
  if (JSON.stringify(invite.json).includes("token")) {
    console.log("\n  WARNING: the response mentions a token. ADR-070 says it must not.");
  } else {
    console.log("       The response carries no token — as ADR-070 requires.");
  }

  console.log(`\n  Now check ${TO}:`);
  console.log(`    - Did it arrive at all?`);
  console.log(`    - Is the sender shown as noreply@plaintabs.com?`);
  console.log(`    - Is it in the inbox rather than spam?`);
  console.log(`    - Does the link open the accept page? (the page itself is not built yet —`);
  console.log(`      a 404 from the frontend still proves the LINK and the domain are right)`);
  console.log(`\n  When done, withdraw the credential it created:`);
  console.log(`    node apps/backend/scripts/revoke-live-invitation.js --email ${TO} --apply\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
