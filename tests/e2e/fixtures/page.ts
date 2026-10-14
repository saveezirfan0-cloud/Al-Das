import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Opens a page and waits until its scripts have loaded, so the first click lands on a hydrated control. A click on
 * server-rendered HTML before React attaches its handlers is silently lost, which made the board tests flaky.
 */
export async function gotoReady(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

/**
 * Clicks `target` until `done` shows. Safe for one-way steps: once `done` is visible it never clicks again, and a
 * second click only happens when the first one plainly did nothing.
 */
export async function clickUntil(target: Locator, done: Locator, timeout = 20_000): Promise<void> {
  await expect(async () => {
    if (await done.isVisible()) return;
    if (await target.isVisible()) await target.click({ timeout: 2_000 });
    await expect(done).toBeVisible({ timeout: 4_000 });
  }).toPass({ timeout });
}
