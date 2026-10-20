import { devices, expect, type Page, test } from "@playwright/test";

import { authFile, type Role, SIGNED_IN_SKIP_REASON, signedIn } from "../fixtures/e2e";
import { gotoReady } from "../fixtures/page";

// The automated half of the Phase H phone pass (docs/34): at a phone's width every role's main pages fit the screen
// (no sideways scroll) and the menu opens as a drawer. Real-device checks (camera, push, install) stay with people.

test.skip(!signedIn, SIGNED_IN_SKIP_REASON);

// A phone's screen and touch, on the suite's own Chromium (a file-level browser change would need a new worker).
const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices["Pixel 7"];
test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });

const PAGES: Record<Role, readonly string[]> = {
  admin: ["/dashboard", "/contacts", "/appointments", "/tasks", "/settings"],
  receptionist: ["/front-desk", "/appointments"],
  agent: ["/inbox", "/enquiries"],
};

async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
}

for (const role of Object.keys(PAGES) as Role[]) {
  test.describe(`${role} on a phone`, () => {
    test.use({ storageState: authFile(role) });

    for (const url of PAGES[role]) {
      test(`${url} fits the screen`, async ({ page }) => {
        await gotoReady(page, url);
        await expect(page.locator("#main-content")).toBeVisible();
        expect(await overflow(page), `${url} scrolls sideways`).toBeLessThanOrEqual(1);
      });
    }

    test("the menu opens as a drawer", async ({ page }) => {
      await gotoReady(page, PAGES[role][0]);
      await page.getByRole("button", { name: "Open navigation" }).click();
      const drawer = page.getByRole("dialog", { name: "Navigation" });
      await expect(drawer).toBeVisible();
      await expect(drawer.getByRole("link").first()).toBeVisible();
    });
  });
}
