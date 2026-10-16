import { describe, expect, it } from "vitest";

import { formatClinicAliases, parseClinicAliases } from "@/lib/finance/branch-aliases";

describe("parseClinicAliases", () => {
  it("splits on ';', trims, drops blanks, duplicates and the long name, and sorts", () => {
    expect(
      parseClinicAliases(
        " Synthetic Clinic - Shore ;; Synthetic  Clinic - Old;Synthetic Clinic - Shore; Main Name ",
        "Main Name",
      ),
    ).toEqual({ ok: true, aliases: ["Synthetic Clinic - Old", "Synthetic Clinic - Shore"] });
    expect(parseClinicAliases("", null)).toEqual({ ok: true, aliases: [] });
  });

  it("refuses more than 10 names or a name over 200 characters", () => {
    const many = Array.from({ length: 11 }, (_, i) => `Clinic ${i}`).join(";");
    expect(parseClinicAliases(many, null).ok).toBe(false);
    expect(parseClinicAliases("x".repeat(201), null).ok).toBe(false);
  });

  it("formats back to one field", () => {
    expect(formatClinicAliases(["A", "B"])).toBe("A; B");
    expect(formatClinicAliases(null)).toBe("");
  });
});
