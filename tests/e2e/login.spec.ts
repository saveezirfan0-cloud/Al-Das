import { expect, test } from "@playwright/test";

test("login page renders and the app redirects signed-out users to it", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard/);
  await expect(page.getByText("Staff access to the Al Das clinic platform.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Email" })).toBeVisible();
  await expect(page.locator("input#password")).toBeVisible();
  await page.getByRole("tab", { name: "Email link" }).click();
  await expect(page.getByRole("button", { name: "Send sign-in link" })).toBeVisible();
});

test("the jobs endpoint rejects requests without the secret", async ({ request }) => {
  const res = await request.post("/api/jobs/outbound");
  expect(res.status()).toBe(401);
});
