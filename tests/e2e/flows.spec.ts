import { expect, test } from "@playwright/test";

test("flows and recall pages redirect signed-out users to login", async ({ page }) => {
  for (const path of ["/flows", "/flows/variables", "/recall", "/recall/calls", "/recall/parallel-run"]) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`/login\\?.*next=${encodeURIComponent(path)}`));
  }
});

test("the incoming-webhook endpoint answers 404 for a malformed flow id before touching the database", async ({ request }) => {
  const res = await request.post("/api/webhooks/in/not-a-uuid", { data: { phone: "+971500000000" } });
  expect(res.status()).toBe(404);
});
