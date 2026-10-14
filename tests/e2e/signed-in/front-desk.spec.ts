import { expect, test } from "@playwright/test";

import { adminDb, authFile, loadSeed, SIGNED_IN_SKIP_REASON, signedIn } from "../fixtures/e2e";

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
  await page.goto(`/front-desk?date=${seed.today}`);
  const board = page.getByRole("region", { name: "Appointments" });
  const line = board.getByRole("listitem").filter({ hasText: seed.patients.frontDesk.name });
  await expect(line).toBeVisible();
  await expect(line).toContainText(seed.specialist.name);

  await line.getByRole("button", { name: "Arrived", exact: true }).click();
  await expect(line.getByText("Waiting", { exact: true })).toBeVisible();

  await line.getByRole("button", { name: "With doctor", exact: true }).click();
  await expect(line.getByRole("button", { name: "Done", exact: true })).toBeVisible();

  await line.getByRole("button", { name: "Done", exact: true }).click();
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
  await page.goto(`/front-desk?date=${seed.today}`);
  await page.getByRole("button", { name: /^Walk-in/ }).click();
  const dialog = page.getByRole("dialog", { name: "Register a walk-in" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
