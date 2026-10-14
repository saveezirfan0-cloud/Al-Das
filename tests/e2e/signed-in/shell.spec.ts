import { expect, test } from "@playwright/test";

import { authFile, SIGNED_IN_SKIP_REASON, signedIn } from "../fixtures/e2e";
import { gotoReady } from "../fixtures/page";

test.skip(!signedIn, SIGNED_IN_SKIP_REASON);
test.use({ storageState: authFile("admin") });

test("the rail shows the areas; pointing at one opens its flyout and the pin docks it", async ({
  page,
}) => {
  await gotoReady(page, "/dashboard");
  const rail = page.getByRole("navigation", { name: "Main" });
  // Home (one page) is a link; an area with pages is a disclosure button that opens them.
  await expect(rail.getByRole("link", { name: "Home", exact: true })).toBeVisible();
  for (const area of ["Today", "Messaging", "CRM", "Insights", "Settings"])
    await expect(rail.getByRole("button", { name: area, exact: true })).toBeVisible();

  // Home has a single page, so nothing is docked on the dashboard.
  const crmPanel = page.getByRole("complementary", { name: "CRM pages" });
  await expect(crmPanel).toHaveCount(0);

  // Pointing at CRM pops its pages out.
  await rail.getByRole("button", { name: "CRM", exact: true }).hover();
  await expect(crmPanel).toBeVisible();
  await expect(crmPanel.getByRole("link", { name: "Patients" })).toBeVisible();
  await expect(crmPanel.getByRole("link", { name: "Enquiries" })).toBeVisible();

  // The pin docks the panel and opens the area's first page.
  await crmPanel.getByRole("button", { name: "Pin CRM menu" }).click();
  await expect(page).toHaveURL(/\/contacts/);
  const unpin = crmPanel.getByRole("button", { name: "Unpin CRM menu" });
  await expect(unpin).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(900, 500); // a docked panel stays when the pointer leaves
  await expect(crmPanel).toBeVisible();

  // Unpinning hides it; pointing again shows the flyout, and pinning docks it again on the same page.
  await unpin.click();
  await expect(crmPanel).toHaveCount(0);
  await rail.getByRole("button", { name: "CRM", exact: true }).hover();
  await crmPanel.getByRole("button", { name: "Pin CRM menu" }).click();
  await page.mouse.move(900, 500);
  await expect(crmPanel.getByRole("button", { name: "Unpin CRM menu" })).toBeVisible();
});

test("the keyboard opens an area's pages from the rail and comes back", async ({ page }) => {
  await gotoReady(page, "/dashboard");
  const rail = page.getByRole("navigation", { name: "Main" });
  const messaging = rail.getByRole("button", { name: "Messaging", exact: true });
  const panel = page.getByRole("complementary", { name: "Messaging pages" });

  await messaging.focus();
  await expect(messaging).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(panel).toBeVisible();
  await expect(messaging).toHaveAttribute("aria-expanded", "true");
  await expect(panel.getByRole("link").first()).toBeFocused();

  // Escape closes the flyout and puts focus back on the area.
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(messaging).toBeFocused();

  // Right arrow opens it too; Tab past the last link closes it and moves on to the next area.
  await page.keyboard.press("ArrowRight");
  await expect(panel).toBeVisible();
  await page.keyboard.press("End");
  await page.keyboard.press("Tab");
  await expect(panel).toHaveCount(0);
  await expect(rail.getByRole("button", { name: "CRM", exact: true })).toBeFocused();
});

test("the branch switcher is hidden when the workspace has one branch", async ({ page }) => {
  // The switcher loads branch names in the browser (the layout stays query-free); wait for that read.
  const branches = page.waitForResponse(
    (r) =>
      r.url().includes("/rest/v1/locations") &&
      r.url().includes("active=eq.true") &&
      r.request().method() === "GET",
  );
  await gotoReady(page, "/dashboard");
  await branches;
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Branch:/ })).toHaveCount(0);
});
