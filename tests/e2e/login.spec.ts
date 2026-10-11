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

test("report and dashboard routes send signed-out users to login", async ({ page }) => {
  for (const path of ["/reports", "/reports/conversations", "/dashboard/management", "/dashboard/team"]) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(path).replace(/\./g, "\\.")}`));
  }
});

test("the report export endpoint rejects signed-out requests", async ({ request }) => {
  const res = await request.post("/api/reports/conversations/export", { data: {}, maxRedirects: 0 });
  expect([307, 401]).toContain(res.status());
});
