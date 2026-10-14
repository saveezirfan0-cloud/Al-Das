/**
 * Phase E (docs/34): pure helpers of the front desk v2. Synthetic data only.
 */
import { describe, expect, it } from "vitest";

import {
  consentCheck,
  eligibilityCheck,
  insuranceCheck,
  notCheckedLines,
  unavailableReason,
} from "@/lib/front-desk/arrival-check";
import {
  bookableDate,
  dayPlan,
  doctorsForBooking,
  presetBranch,
  servicesAtBranch,
} from "@/lib/front-desk/book";
import {
  cashupHref,
  median,
  summariseDayByBranch,
  waitMinutes,
  wasSeen,
  type DayRow,
} from "@/lib/front-desk/day-summary";
import { cardFlags } from "@/lib/front-desk/patient-card";
import {
  bookingNumber,
  paymentLines,
  RECEIPT_NOTICE,
  slipFirstName,
  slipKind,
} from "@/lib/front-desk/slip";
import { whatsappDeclined } from "@/lib/front-desk/whatsapp-consent";

describe("booking from the desk", () => {
  const doctors = [
    { id: "d2", name: "Dr Zed", location_ids: ["l1"], service_ids: ["s1"] },
    { id: "d1", name: "Dr Amal", location_ids: ["l1", "l2"], service_ids: ["s1", "s2"] },
    { id: "d3", name: "Dr Other", location_ids: ["l2"], service_ids: ["s1"] },
  ];
  const services = [
    { id: "s1", name: "Consultation" },
    { id: "s2", name: "Dressing" },
    { id: "s3", name: "Nobody does this" },
  ];

  it("lists only the branch's doctors who do the service, by name", () => {
    expect(doctorsForBooking(doctors, "l1", "s1").map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(doctorsForBooking(doctors, "l1", "s2").map((d) => d.id)).toEqual(["d1"]);
    expect(doctorsForBooking(doctors, "l1", null)).toEqual([]);
    expect(doctorsForBooking(doctors, null, "s1")).toEqual([]);
  });

  it("offers only services someone at the branch does", () => {
    expect(servicesAtBranch(services, doctors, "l1").map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(servicesAtBranch(services, doctors, "l2").map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(servicesAtBranch(services, doctors, "")).toEqual([]);
  });

  it("presets the switcher's branch, else the only branch, else nothing", () => {
    const locs = [{ id: "l1" }, { id: "l2" }];
    expect(presetBranch(locs, "l2")).toBe("l2");
    expect(presetBranch(locs, "lX")).toBeNull(); // a branch the member cannot book in is never preset
    expect(presetBranch([{ id: "l1" }], null)).toBe("l1");
    expect(presetBranch(locs, null)).toBeNull();
  });

  it("drops past times, orders doctors by their first free time and lists full ones apart", () => {
    const now = new Date("2026-10-14T06:00:00.000Z");
    const plan = dayPlan(
      [
        {
          specialist_id: "d2",
          name: "Dr Zed",
          slots: [
            { start: "2026-10-14T05:30:00.000Z", label: "09:30" }, // past
            { start: "2026-10-14T06:30:00.000Z", label: "10:30" },
          ],
        },
        {
          specialist_id: "d1",
          name: "Dr Amal",
          slots: [{ start: "2026-10-14T07:00:00.000Z", label: "11:00" }],
        },
        {
          specialist_id: "d3",
          name: "Dr Busy",
          slots: [{ start: "2026-10-14T05:00:00.000Z", label: "09:00" }],
        },
      ],
      now,
    );
    expect(plan.open.map((d) => d.specialist_id)).toEqual(["d2", "d1"]);
    expect(plan.open[0].slots.map((s) => s.label)).toEqual(["10:30"]);
    expect(plan.full).toEqual([{ specialist_id: "d3", name: "Dr Busy" }]);
  });

  it("caps the buttons per doctor", () => {
    const slots = Array.from({ length: 40 }, (_, i) => ({
      start: new Date(Date.UTC(2026, 9, 14, 8, i * 5)).toISOString(),
      label: `t${i}`,
    }));
    const plan = dayPlan(
      [{ specialist_id: "d", name: "D", slots }],
      new Date("2026-10-14T00:00:00Z"),
      10,
    );
    expect(plan.open[0].slots).toHaveLength(10);
  });

  it("books from today up to 90 days ahead only", () => {
    expect(bookableDate("2026-10-14", "2026-10-14")).toBe(true);
    expect(bookableDate("2027-01-12", "2026-10-14")).toBe(true); // day 90
    expect(bookableDate("2027-01-13", "2026-10-14")).toBe(false);
    expect(bookableDate("2026-10-13", "2026-10-14")).toBe(false);
    expect(bookableDate("2026-02-30", "2026-01-01")).toBe(false);
    expect(bookableDate("14/10/2026", "2026-10-14")).toBe(false);
  });
});

describe("arrival check panel (fails closed)", () => {
  const today = "2026-10-14";

  it("says 'Not checked' with the reason when documents are off or not allowed", () => {
    expect(
      unavailableReason({ featureOn: false, featureName: "patient documents", permitted: true }),
    ).toBe("patient documents off");
    expect(unavailableReason({ featureOn: true, featureName: "x", permitted: false })).toBe(
      "no access",
    );
    expect(
      unavailableReason({ featureOn: true, featureName: "x", permitted: true }),
    ).toBeUndefined();
    expect(
      insuranceCheck({
        available: false,
        why: "patient documents off",
        cards: [],
        today,
        leadDays: 14,
      }),
    ).toEqual({
      key: "insurance",
      tone: "unknown",
      label: "Not checked (patient documents off)",
    });
    expect(insuranceCheck({ available: true, cards: null, today, leadDays: 14 }).tone).toBe(
      "unknown",
    );
  });

  it("says all three are not checked when nothing could be loaded", () => {
    expect(notCheckedLines("could not load")).toEqual([
      { key: "insurance", tone: "unknown", label: "Not checked (could not load)" },
      { key: "eligibility", tone: "unknown", label: "Not checked (could not load)" },
      { key: "consent", tone: "unknown", label: "Not checked (could not load)" },
    ]);
  });

  it("reads the insurance card from expiry dates only", () => {
    const card = (expires_on: string | null, over = {}) => ({
      expires_on,
      status: "ready",
      scan_status: "unscanned",
      ...over,
    });
    const check = (cards: ReturnType<typeof card>[]) =>
      insuranceCheck({ available: true, cards, today, leadDays: 14 });
    expect(check([])).toMatchObject({ tone: "warn", label: "No insurance card on file" });
    expect(check([card("2027-01-01")])).toMatchObject({
      tone: "ok",
      label: "Insurance card valid",
    });
    expect(check([card("2026-10-20")])).toMatchObject({
      tone: "warn",
      label: "Insurance card expires in 6 d",
    });
    expect(check([card("2026-10-14")])).toMatchObject({ label: "Insurance card expires today" });
    expect(check([card("2026-10-01")])).toMatchObject({
      tone: "alert",
      label: "Insurance card expired",
    });
    expect(check([card(null)])).toMatchObject({
      tone: "warn",
      label: "Insurance card on file, no expiry date",
    });
    // The longest-running card decides; pending and infected files do not count.
    expect(check([card("2026-10-01"), card("2027-06-01")]).tone).toBe("ok");
    expect(check([card("2027-06-01", { status: "pending" })]).label).toBe(
      "No insurance card on file",
    );
    expect(check([card("2027-06-01", { scan_status: "infected" })]).label).toBe(
      "No insurance card on file",
    );
  });

  it("reads eligibility from the newest check and never guesses an unknown status", () => {
    const e = (status: string, valid_to: string | null, checked_on: string | null) => ({
      status,
      valid_to,
      checked_on,
    });
    const check = (checks: ReturnType<typeof e>[] | null, available = true) =>
      eligibilityCheck({ available, checks, today });
    expect(check(null).tone).toBe("unknown");
    expect(check([], false).label).toBe("Not checked (no access)");
    expect(check([])).toMatchObject({ tone: "warn", label: "No eligibility check" });
    expect(check([e("verified", "2026-12-31", "2026-10-01")])).toMatchObject({
      tone: "ok",
      label: "Cover verified to 2026-12-31",
    });
    expect(check([e("verified", "2026-10-01", "2026-09-01")])).toMatchObject({
      tone: "alert",
      label: "Cover ended",
    });
    expect(
      check([e("verified", "2027-01-01", "2026-09-01"), e("failed", null, "2026-10-10")]).label,
    ).toBe("Eligibility check failed");
    expect(check([e("pending", null, "2026-10-10")]).tone).toBe("warn");
    expect(check([e("mystery", null, "2026-10-10")]).tone).toBe("unknown");
    expect(check([e("verified", null, "2026-10-10")]).tone).toBe("unknown");
  });

  it("reads consent forms from e-signature states", () => {
    const r = (status: string, created_at = "2026-10-10T00:00:00Z") => ({ status, created_at });
    const check = (requests: ReturnType<typeof r>[] | null, available = true) =>
      consentCheck({ available, requests, why: available ? undefined : "e-signature off" });
    expect(check([], false).label).toBe("Not checked (e-signature off)");
    expect(check(null).tone).toBe("unknown");
    expect(check([])).toMatchObject({ tone: "warn", label: "No consent form sent" });
    expect(check([r("pending")])).toMatchObject({
      tone: "warn",
      label: "Consent form waiting for signature",
    });
    expect(check([r("declined", "2026-10-11T00:00:00Z"), r("signed")])).toMatchObject({
      tone: "ok",
    });
    expect(check([r("expired")])).toMatchObject({
      tone: "alert",
      label: "Consent form not signed",
    });
    expect(check([r("weird")]).tone).toBe("unknown");
  });
});

describe("end of day per branch", () => {
  const row = (over: Partial<DayRow>): DayRow => ({
    status: "confirmed",
    checkin_status: null,
    is_walk_in: false,
    arrived_at: null,
    with_doctor_at: null,
    location_id: "l1",
    location_name: "Jumeirah",
    ...over,
  });

  it("takes the median (mean of the middle two for an even count)", () => {
    expect(median([])).toBeNull();
    expect(median([7])).toBe(7);
    expect(median([10, 2, 6])).toBe(6);
    expect(median([1, 2, 3, 10])).toBe(3); // 2.5 rounds to 3
  });

  it("waits run from Arrived to With doctor and impossible orders are ignored", () => {
    expect(
      waitMinutes({ arrived_at: "2026-10-14T05:00:00Z", with_doctor_at: "2026-10-14T05:12:00Z" }),
    ).toBe(12);
    expect(waitMinutes({ arrived_at: "2026-10-14T05:00:00Z", with_doctor_at: null })).toBeNull();
    expect(
      waitMinutes({ arrived_at: "2026-10-14T05:10:00Z", with_doctor_at: "2026-10-14T05:00:00Z" }),
    ).toBeNull();
  });

  it("counts seen, no-shows, cancelled, walk-ins and waits per branch, branches by name, no branch last", () => {
    const rows: DayRow[] = [
      row({
        checkin_status: "done",
        arrived_at: "2026-10-14T05:00:00Z",
        with_doctor_at: "2026-10-14T05:10:00Z",
      }),
      row({
        checkin_status: "checked_out",
        arrived_at: "2026-10-14T06:00:00Z",
        with_doctor_at: "2026-10-14T06:30:00Z",
      }),
      row({ status: "no_show" }),
      row({ status: "cancelled" }),
      row({ is_walk_in: true, checkin_status: "arrived", arrived_at: "2026-10-14T07:00:00Z" }),
      row({ status: "completed", location_id: "l2", location_name: "Al Barsha" }),
      row({ location_id: null, location_name: null }),
    ];
    const { branches, total } = summariseDayByBranch(rows);
    expect(branches.map((b) => b.location_name)).toEqual(["Al Barsha", "Jumeirah", "No branch"]);
    const j = branches[1];
    expect(j).toMatchObject({
      booked: 4, // cancelled visits are counted apart
      seen: 2,
      noShows: 1,
      cancelled: 1,
      walkIns: 1,
      stillWaiting: 1,
      medianWaitMin: 20,
      waits: 2,
    });
    expect(branches[0]).toMatchObject({ seen: 1, medianWaitMin: null });
    expect(total).toMatchObject({
      booked: 6,
      seen: 3,
      cancelled: 1,
      location_name: "All branches",
    });
    expect(wasSeen({ status: "awaiting", checkin_status: "with_doctor" })).toBe(true);
    expect(wasSeen({ status: "awaiting", checkin_status: "arrived" })).toBe(false);
  });

  it("links to the cash-up only with the permission and a finance branch code", () => {
    expect(cashupHref("JUM", "2026-10-14", true)).toBe(
      "/finance/cashup?branch=JUM&date=2026-10-14",
    );
    expect(cashupHref("JUM", "2026-10-14", false)).toBeNull();
    expect(cashupHref(null, "2026-10-14", true)).toBeNull();
    expect(cashupHref("A&B", "2026-10-14", true)).toContain("branch=A%26B");
  });
});

describe("slip and payment record", () => {
  it("prints the first name only", () => {
    expect(slipFirstName("Layla", "Layla Demo-07")).toBe("Layla");
    expect(slipFirstName("", "Omar Demo-02 Example")).toBe("Omar");
    expect(slipFirstName("  Sara  Jane ", null)).toBe("Sara");
    expect(slipFirstName(null, null)).toBe("Patient");
    expect(bookingNumber(1042)).toBe("Booking 1042");
    expect(slipKind("receipt")).toBe("receipt");
    expect(slipKind("anything")).toBe("slip");
  });

  it("lists payments and refunds, never an invoice total, and says it is not a tax invoice", () => {
    const { lines, total } = paymentLines(
      [
        {
          paid: 150,
          refund: null,
          paid_date: "2026-10-14",
          payment_mode: "Card",
          receipt_number: "R-1",
          is_current: true,
        },
        {
          paid: 0,
          refund: 20,
          paid_date: "2026-10-15",
          payment_mode: "Card",
          receipt_number: "R-2",
          is_current: true,
        },
        {
          paid: 999,
          refund: null,
          paid_date: "2026-10-13",
          payment_mode: "Cash",
          receipt_number: "OLD",
          is_current: false,
        },
      ],
      [
        {
          status: "paid",
          amount_paid_minor: 5000,
          amount_minor: 5000,
          paid_at: "2026-10-14T09:00:00Z",
          invoice_number: "INV-9",
        },
        {
          status: "pending",
          amount_paid_minor: null,
          amount_minor: 7000,
          paid_at: null,
          invoice_number: "INV-10",
        },
      ],
    );
    expect(lines.map((l) => [l.mode, l.amount])).toEqual([
      ["Card", 150],
      ["Online payment link", 50],
      ["Refund", -20],
    ]);
    expect(total).toBe(180);
    expect(RECEIPT_NOTICE).toMatch(/not a tax invoice/);
  });
});

describe("no WhatsApp without the patient's agreement", () => {
  it("reads the refusal and flags it on the card", () => {
    expect(whatsappDeclined({ whatsapp_declined_at: "2026-10-14T05:00:00Z" })).toBe(true);
    expect(whatsappDeclined({ whatsapp_declined_at: null })).toBe(false);
    expect(whatsappDeclined(null)).toBe(false);
    const base = {
      stop_marketing: false,
      has_phone: true,
      has_bsuid: false,
      dob: null,
      no_shows_12m: 0,
      open_call_tasks: 0,
      waitlist_entries: 0,
      guardian: null,
      dependants: 0,
    };
    expect(cardFlags({ ...base, whatsapp_declined: true }).map((f) => f.key)).toContain(
      "whatsapp_declined",
    );
    expect(cardFlags(base).map((f) => f.key)).not.toContain("whatsapp_declined");
  });
});
