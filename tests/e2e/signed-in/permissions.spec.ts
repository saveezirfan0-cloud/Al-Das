import { expect, test } from "@playwright/test";

import { authFile, SIGNED_IN_SKIP_REASON, signedIn } from "../fixtures/e2e";
import { gotoReady } from "../fixtures/page";

test.skip(!signedIn, SIGNED_IN_SKIP_REASON);

/** app/(app)/error.tsx renders this for a missing permission (ForbiddenError). */
const NO_ACCESS = /have access to this page/;

test.describe("Admin", () => {
  test.use({ storageState: authFile("admin") });

  test("can open Settings, Users", async ({ page }) => {
    await gotoReady(page, "/settings/users");
    await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: NO_ACCESS })).toHaveCount(0);
  });
});

test.describe("Receptionist", () => {
  test.use({ storageState: authFile("receptionist") });

  test("cannot open Settings, Users (no-access page)", async ({ page }) => {
    await gotoReady(page, "/settings/users");
    await expect(page.getByRole("heading", { name: NO_ACCESS })).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to my home page" })).toBeVisible();
  });
});

test.describe("Agent", () => {
  test.use({ storageState: authFile("agent") });

  test("cannot open Finance", async ({ page }) => {
    // The module index sends a member with no finance page home instead of showing the module.
    await gotoReady(page, "/finance");
    await expect(page).toHaveURL(/\/dashboard/);
    const rail = page.getByRole("navigation", { name: "Main" });
    await expect(rail.getByRole("link", { name: "Home", exact: true })).toBeVisible();
    await expect(rail.getByRole("link", { name: "Finance", exact: true })).toHaveCount(0);

    // A finance page itself refuses with the no-access page.
    await gotoReady(page, "/finance/claims");
    await expect(page.getByRole("heading", { name: NO_ACCESS })).toBeVisible();
  });
});
