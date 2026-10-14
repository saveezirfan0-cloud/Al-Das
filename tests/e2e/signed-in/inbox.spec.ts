import { expect, test } from "@playwright/test";

import {
  adminDb,
  authFile,
  E2E_JOB_SECRET,
  escapeRegExp,
  loadSeed,
  SIGNED_IN_SKIP_REASON,
  signedIn,
} from "../fixtures/e2e";

test.skip(!signedIn, SIGNED_IN_SKIP_REASON);
test.use({ storageState: authFile("admin") });

test("open the seeded conversation and add an internal note", async ({ page }) => {
  const seed = loadSeed();
  await page.goto("/inbox");
  const list = page.getByRole("region", { name: "Conversations" });
  await list
    .getByRole("button", { name: new RegExp(escapeRegExp(seed.patients.inbox.name)) })
    .click();
  await expect(page).toHaveURL(new RegExp(`[?&]c=${seed.conversationId}`));

  const thread = page.getByRole("log", { name: "Messages" });
  await expect(thread.getByText(seed.inboundText)).toBeVisible();

  const note = `E2E internal note ${Date.now()}`;
  await page.getByRole("button", { name: /^comment$/i }).click();
  await page.getByRole("textbox", { name: "Internal note" }).fill(note);
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  const bubble = thread.getByText(note, { exact: true }).locator("xpath=..");
  await expect(bubble).toBeVisible();
  await expect(bubble).toContainText("Internal note");
});

test("a WhatsApp reply in training mode is marked sent on screen and never reaches Meta", async ({
  page,
  request,
}) => {
  const seed = loadSeed();
  await page.goto(`/inbox?c=${seed.conversationId}`);
  // The seeded workspace is a training workspace (orgs.is_training): the banner says so on every page.
  await expect(page.getByRole("status").filter({ hasText: "TRAINING MODE" })).toBeVisible();

  const text = `E2E reply ${Date.now()}`;
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const thread = page.getByRole("log", { name: "Messages" });
  await expect(thread.getByText(text, { exact: true })).toBeVisible();

  // Drain the live-chat queue the way pg_cron does. In a training workspace the outbound job never builds a Meta
  // client; the test server also has no Meta credentials at all.
  const drained = await request.post("/api/jobs/outbound_priority", {
    headers: { "x-job-secret": E2E_JOB_SECRET },
  });
  expect(drained.ok()).toBe(true);

  // The training marker: a made-up `training:` id and `payload.training`, status sent.
  await expect
    .poll(async () => {
      const { data } = await adminDb()
        .from("messages")
        .select("status, wa_message_id, payload")
        .eq("conversation_id", seed.conversationId)
        .eq("body", text)
        .maybeSingle();
      return {
        status: data?.status,
        simulated: data?.wa_message_id?.startsWith("training:") ?? false,
        flagged: (data?.payload as { training?: boolean } | null)?.training === true,
      };
    })
    .toEqual({ status: "sent", simulated: true, flagged: true });

  // On screen it reads as sent.
  await page.reload();
  const bubble = page
    .getByRole("log", { name: "Messages" })
    .getByText(text, { exact: true })
    .locator("xpath=..");
  await expect(bubble.getByLabel("Sent", { exact: true })).toBeVisible();
});
