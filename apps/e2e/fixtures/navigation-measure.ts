import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * ADR-081 INSTRUMENT — the one open question, left armed.
 *
 * The question is whether a **second** click navigates when the first does not: if it does, the
 * flake is a UX defect a person meets on a slow phone and presses twice; if it does not, the state
 * is stuck and that is worse. It cannot be answered locally — 60 full-suite runs produced zero
 * reproductions — so the measurement is left in the three assertions that suffer it, to be answered
 * by the next real failure wherever it happens.
 *
 * **It does not make a failing test pass, and it does not change a passing one.** The first wait is
 * 15 s, exactly the `expect` timeout of the `toHaveURL` assertion it replaces, so the first click is
 * judged by the same standard as before. Everything after that runs only once the test has already
 * failed.
 *
 * **Why the timeout is raised on the failure path.** A test gets 30 s. A first wait of 15 s plus the
 * measurement would exceed it, and Playwright would kill the test with `Test timeout exceeded`
 * before the answer was ever printed — an instrument that cannot report is worse than none, because
 * it looks like one. The raise applies only after the first click has already failed, so it can
 * never buy a passing result: the test fails either way, and the difference is whether the failure
 * carries the answer.
 */
export async function clickAndMeasureNavigation(
  page: Page,
  link: Locator,
  label: string,
  target: RegExp,
): Promise<void> {
  await link.click();

  try {
    await page.waitForURL(target, { timeout: 15_000 });
    return;
  } catch {
    // The first click did not navigate. The test has failed. Everything below is the measurement,
    // and the room it needs is bought here rather than in the config, where it would also apply to
    // the runs that pass.
    test.setTimeout(90_000);
  }

  let second = "no";
  let afterwards = "-";
  try {
    await link.click({ timeout: 5_000 });
    await page.waitForURL(target, { timeout: 8_000 });
    second = "yes";
  } catch {
    // A navigation that works takes 100-900 ms (ADR-081), so 8 s is not a near miss. Ask one more
    // question: is the router stuck, or is the whole page stuck?
    try {
      const href = await link.getAttribute("href", { timeout: 5_000 });
      await page.goto(href ?? "/", { timeout: 10_000 });
      afterwards = target.test(page.url()) ? "goto works" : "goto landed elsewhere";
    } catch {
      afterwards = "goto failed";
    }
  }

  expect(
    false,
    `ADR-081 MEASUREMENT — ${label}: first click did not navigate.` +
      ` secondClickNavigated=${second}; afterSecondFailure=${afterwards}; url=${page.url()}`,
  ).toBe(true);
}
