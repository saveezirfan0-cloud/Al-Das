import { expect, test } from "@playwright/test";

import { authFile, loadSeed, SIGNED_IN_SKIP_REASON, signedIn } from "../fixtures/e2e";

test.skip(!signedIn, SIGNED_IN_SKIP_REASON);
// An Agent works with patient records every day (contacts.view / contacts.manage).
test.use({ storageState: authFile("agent") });

test("the Patients list shows the seeded patient and the record drawer opens", async ({ page }) => {
  const { patients } = loadSeed();
  await page.goto("/contacts");
  await expect(page.getByRole("heading", { name: "Patients", exact: true })).toBeVisible();

  const row = page.getByRole("row").filter({ hasText: patients.listed.name });
  await expect(row).toBeVisible();
  await row.getByText(patients.listed.name, { exact: true }).click();

  const drawer = page.getByRole("dialog", { name: patients.listed.name });
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`[?&]contact=${patients.listed.id}`));
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
});
