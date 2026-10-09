import { expect, test } from "@playwright/test";

test("enquiries, tasks and their settings redirect signed-out users to login", async ({ page }) => {
  await page.goto("/enquiries?pipeline=all&mode=table");
  await expect(page).toHaveURL(/\/login\?.*next=%2Fenquiries/);
  await page.goto("/tasks?state=overdue");
  await expect(page).toHaveURL(/\/login\?.*next=%2Ftasks/);
  await page.goto("/settings/enquiries");
  await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Fenquiries/);
});

test("the enquiries export endpoint rejects signed-out requests", async ({ request }) => {
  const res = await request.post("/api/enquiries/export", {
    data: { scope: "all" },
    maxRedirects: 0,
  });
  expect([307, 401]).toContain(res.status());
  if (res.status() === 307) expect(res.headers()["location"]).toContain("/login");
});
