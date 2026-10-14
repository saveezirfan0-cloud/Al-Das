import { expect, test } from "@playwright/test";

import { authFile, escapeRegExp, loadSeed, SIGNED_IN_SKIP_REASON, signedIn } from "../fixtures/e2e";

test.skip(!signedIn, SIGNED_IN_SKIP_REASON);
test.use({ storageState: authFile("admin") });

/** A free slot button in a slot list is labelled with its time only ("08:15"); taken ones add ", Booked". */
const FREE_SLOT = /^\d{2}:\d{2}$/;

test("book an appointment in a free slot through the drawer, see it in the day grid, then move it", async ({
  page,
}) => {
  const seed = loadSeed();
  const patient = seed.patients.booking;
  // A booking in the day grid reads "<patient> <start>–<end>".
  const inGrid = (start: string) =>
    page.getByRole("button", { name: new RegExp(`${escapeRegExp(patient.name)}\\s*${start}–`) });

  // "Book appointment" from a patient record lands here: the drawer opens with the patient filled in.
  await page.goto(`/appointments?date=${seed.bookingDate}&new=${patient.id}`);
  const drawer = page.getByRole("dialog", { name: "New appointment" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(patient.name, { exact: true })).toBeVisible();

  await drawer.getByRole("combobox").filter({ hasText: "Choose a specialist" }).click();
  await page.getByRole("option", { name: seed.specialist.name }).click();
  await drawer.getByRole("combobox").filter({ hasText: "Choose a service" }).click();
  await page.getByRole("option", { name: seed.service.name }).click();

  // The first free time that day (earlier runs on the same stack may have taken some).
  const firstFree = drawer.getByRole("button", { name: FREE_SLOT }).first();
  await expect(firstFree).toBeVisible();
  const startLabel = (await firstFree.innerText()).trim();
  const slot = drawer.getByRole("button", { name: startLabel, exact: true });
  await slot.click();
  await expect(slot).toHaveAttribute("aria-pressed", "true");
  await drawer.getByRole("button", { name: "Book appointment" }).click();
  await expect(page.getByText(/Appointment #\d+ booked\./)).toBeVisible();
  await expect(drawer).toBeHidden();

  // The resource day grid shows the booking at that time.
  const booked = inGrid(startLabel);
  await expect(booked).toBeVisible();

  // Move it to the last free time of the day.
  await booked.click();
  const details = page.getByRole("dialog", { name: /^Appointment #\d+/ });
  await expect(details).toBeVisible();
  await details.getByRole("button", { name: "Pick a new time" }).click();
  const moveSlots = details.getByRole("button", { name: FREE_SLOT });
  await expect(moveSlots.first()).toBeVisible();
  const newLabel = (await moveSlots.last().innerText()).trim();
  expect(newLabel).not.toBe(startLabel);
  await details.getByRole("button", { name: newLabel, exact: true }).click();
  await details.getByRole("button", { name: "Move appointment" }).click();
  await expect(page.getByText("Appointment rescheduled.")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
  await expect(inGrid(newLabel)).toBeVisible();
  await expect(inGrid(startLabel)).toHaveCount(0);
});
