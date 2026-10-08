import { expect, test } from "@playwright/test";

test("contacts and settings pages redirect signed-out users to login", async ({ page }) => {
  await page.goto("/contacts?view=recent7");
  await expect(page).toHaveURL(/\/login\?.*next=%2Fcontacts/);
  await page.goto("/settings/custom-fields");
  await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Fcustom-fields/);
});

test("the contacts export endpoint rejects signed-out requests", async ({ request }) => {
  // The middleware redirects signed-out callers to /login; the route itself answers 401 if reached.
  const res = await request.post("/api/contacts/export", {
    data: { scope: "all" },
    maxRedirects: 0,
  });
  expect([307, 401]).toContain(res.status());
  if (res.status() === 307) expect(res.headers()["location"]).toContain("/login");
});
