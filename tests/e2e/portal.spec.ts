import { expect, test } from "@playwright/test";

test("portal pages redirect signed-out users to login", async ({ page }) => {
  await page.goto("/portal");
  await expect(page).toHaveURL(/\/login\?.*next=%2Fportal/);
  await page.goto("/portal/ref_diagnoses?view=abc&record=def");
  await expect(page).toHaveURL(/\/login\?.*next=%2Fportal%2Fref_diagnoses/);
});

test("the portal export endpoint rejects signed-out requests", async ({ request }) => {
  const res = await request.post("/api/portal/ref_diagnoses/export", {
    data: { scope: "all" },
    maxRedirects: 0,
  });
  expect([307, 401]).toContain(res.status());
  if (res.status() === 307) expect(res.headers()["location"]).toContain("/login");
});
