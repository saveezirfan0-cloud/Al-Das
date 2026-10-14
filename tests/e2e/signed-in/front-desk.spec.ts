import { expect, test } from "@playwright/test";

import { adminDb, authFile, loadSeed, SIGNED_IN_SKIP_REASON, signedIn } from "../fixtures/e2e";
import { gotoReady } from "../fixtures/page";

test.skip(!signedIn, SIGNED_IN_SKIP_REASON);
test.use({ storageState: authFile("receptionist") });

test("today's board shows the seeded appointment and check-in moves Arrived → With doctor → Done", async ({
  page,
}) => {
  const seed = loadSeed();
  // Re-runnable: put the seeded appointment back to "not arrived" (set-up only, service role on the local stack).
  const { error } = await adminDb()
    .from("appointments")
    .update({
      status: "confirmed",
      checkin_status: null,
      arrived_at: null,
      with_doctor_at: null,
      done_at: null,
      checked_out_at: null,
    })
    .eq("id", seed.frontDeskAppointmentId);
  expect(error).toBeNull();

  // The date is pinned so a run that crosses clinic midnight still opens the seeded day.
  await gotoReady(page, `/front-desk?date=${seed.today}`);
  const board = page.getByRole("region", { name: "Appointments" });
  const line = board.getByRole("listitem").filter({ hasText: seed.patients.frontDesk.name });
  await expect(line).toBeVisible();
  await expect(line).toContainText(seed.specialist.name);

  // One click per step, then the saved state, then the board. Split this way a failure says whether the action did not
  // save or the board did not catch up (a toast with the action's error is attached to the message).
  const savedState = async () =>
    (
      await adminDb()
        .from("appointments")
        .select("checkin_status")
        .eq("id", seed.frontDeskAppointmentId)
        .single()
    ).data?.checkin_status ?? null;
  const step = async (button: string, state: string) => {
    await line.getByRole("button", { name: button, exact: true }).click();
    try {
      await expect.poll(savedState, { timeout: 20_000 }).toBe(state);
    } catch (e) {
      const toasts = await page.locator("[data-sonner-toast]").allInnerTexts();
      throw new Error(`"${button}" did not save. Toasts: ${JSON.stringify(toasts)}`, { cause: e });
    }
  };

  await step("Arrived", "arrived");
  await expect(line.getByText("Waiting", { exact: true })).toBeVisible();

  await step("With doctor", "with_doctor");
  await expect(line.getByRole("button", { name: "Done", exact: true })).toBeVisible();

  await step("Done", "done");
  await expect(line.getByRole("button", { name: "Checked out", exact: true })).toBeVisible();
  await expect(line.getByText("Done", { exact: true })).toBeVisible();

  // Saved in Pulse (never in Unite): Done also completes a Pulse booking.
  await expect
    .poll(async () => {
      const { data } = await adminDb()
        .from("appointments")
        .select("checkin_status, status")
        .eq("id", seed.frontDeskAppointmentId)
        .single();
      return data;
    })
    .toEqual({ checkin_status: "done", status: "completed" });
});

test("the walk-in dialog opens from the board", async ({ page }) => {
  const seed = loadSeed();
  await gotoReady(page, `/front-desk?date=${seed.today}`);
  await page.getByRole("button", { name: /^Walk-in/ }).click();
  const dialog = page.getByRole("dialog", { name: "Register a walk-in" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
