import { describe, expect, it } from "vitest";

import {
  ageInYears,
  ageLabel,
  capNote,
  consentChips,
  headerLifecycle,
  medicineWindow,
} from "@/lib/contacts/patient-360";

describe("patient 360 helpers", () => {
  it("computes age on the birthday boundary", () => {
    expect(ageInYears("2000-10-17", "2026-10-17")).toBe(26);
    expect(ageInYears("2000-10-18", "2026-10-17")).toBe(25);
    expect(ageInYears(null, "2026-10-17")).toBeNull();
    expect(ageInYears("2030-01-01", "2026-10-17")).toBeNull();
    expect(ageInYears("not-a-date", "2026-10-17")).toBeNull();
  });

  it("labels babies in months", () => {
    expect(ageLabel("2026-04-10", "2026-10-17")).toBe("6 months");
    expect(ageLabel("2026-10-01", "2026-10-17")).toBe("under 1 month");
    expect(ageLabel("2020-01-01", "2026-10-17")).toBe("6 years");
  });

  it("shows the three consent chips", () => {
    const chips = consentChips({
      phone_e164: "+447700900001",
      whatsapp_declined_at: null,
      promotions_opt_in: true,
      stop_marketing: true,
      clinical_messaging_consent: false,
    });
    expect(chips.map((c) => c.tone)).toEqual(["ok", "warn", "off"]);
    expect(
      consentChips({
        phone_e164: null,
        whatsapp_declined_at: "2026-01-01T00:00:00Z",
        promotions_opt_in: false,
        stop_marketing: false,
        clinical_messaging_consent: true,
      })[0].tone,
    ).toBe("warn");
  });

  it("derives the lifecycle stage with default thresholds", () => {
    const t = "2026-10-17";
    expect(headerLifecycle({ unitePin: null, firstVisitDate: null, lastVisitDate: null }, t)).toBe(
      "lead",
    );
    expect(
      headerLifecycle(
        { unitePin: "P1", firstVisitDate: "2026-09-01", lastVisitDate: "2026-09-01" },
        t,
      ),
    ).toBe("new_patient");
    expect(
      headerLifecycle(
        { unitePin: "P1", firstVisitDate: "2020-01-01", lastVisitDate: "2020-02-01" },
        t,
      ),
    ).toBe("lapsed");
  });

  it("decides whether a medicine is current and fails closed on missing data", () => {
    expect(medicineWindow("2026-10-10", 10, "2026-10-17")).toEqual({
      endsOn: "2026-10-19",
      current: true,
    });
    expect(medicineWindow("2026-09-01", 5, "2026-10-17").current).toBe(false);
    expect(medicineWindow(null, 5, "2026-10-17").current).toBeNull();
    expect(medicineWindow("2026-10-10", null, "2026-10-17").current).toBeNull();
    expect(medicineWindow("2026-12-01", 5, "2026-10-17").current).toBe(false);
  });

  it("caps and trims notes", () => {
    expect(capNote("   ")).toBeNull();
    expect(capNote("a".repeat(30), 10)).toBe(`${"a".repeat(10)}…`);
  });
});
