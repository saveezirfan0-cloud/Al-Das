import { describe, expect, it } from "vitest";

import {
  billReadiness,
  type EligibilityFact,
  type PreauthFact,
} from "@/lib/finance/bill-readiness";

import fixture from "./fixtures/phase18-readiness.synthetic.json";

type FixtureCheck = Omit<EligibilityFact, "createdAt">;

const toChecks = (checks: FixtureCheck[]): EligibilityFact[] =>
  checks.map((c, i) => ({ ...c, createdAt: `2026-10-0${i + 1}T00:00:00Z` }));

describe("billReadiness (shared fixture)", () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const v = billReadiness({
        invoiceDate: c.invoiceDate,
        patientPin: c.pin,
        today: fixture.today,
        readyStartDate: fixture.settings.readyStartDate,
        readyGraceDays: fixture.settings.readyGraceDays,
        checks: toChecks(c.checks as FixtureCheck[]),
        needsPreauth: c.needsPreauth,
        preauths: c.preauths as PreauthFact[],
      });
      expect(v.evaluated).toBe(c.expected.evaluated);
      expect(v.reasons).toEqual(c.expected.reasons);
      expect(v.ready).toBe(c.expected.reasons.length === 0);
    });
  }

  it("evaluates nothing while the check is switched off (no start date)", () => {
    const v = billReadiness({
      invoiceDate: "2026-10-05",
      patientPin: null,
      today: "2026-10-20",
      readyStartDate: null,
      readyGraceDays: 1,
      checks: [],
      needsPreauth: true,
      preauths: [],
    });
    expect(v).toEqual({ evaluated: false, ready: true, reasons: [] });
  });

  it("uses the newest check by checked date, then creation time", () => {
    const base = { validFrom: null, validTo: "2026-12-31", hasDocument: true };
    const v = billReadiness({
      invoiceDate: "2026-10-05",
      patientPin: "PIN-X",
      today: "2026-10-20",
      readyStartDate: "2026-09-01",
      readyGraceDays: 1,
      checks: [
        {
          ...base,
          status: "verified",
          checkedOn: "2026-10-01",
          createdAt: "2026-10-01T09:00:00Z",
          hasDocument: false,
        },
        {
          ...base,
          status: "verified",
          checkedOn: "2026-10-01",
          createdAt: "2026-10-01T10:00:00Z",
          hasDocument: true,
        },
      ],
      needsPreauth: false,
      preauths: [],
    });
    expect(v.reasons).toEqual([]); // the later one (with a card) wins
  });

  it("does not let a pre-auth held under no PIN cover a PIN-less invoice", () => {
    const v = billReadiness({
      invoiceDate: "2026-10-05",
      patientPin: null,
      today: "2026-10-20",
      readyStartDate: "2026-09-01",
      readyGraceDays: 1,
      checks: [],
      needsPreauth: true,
      preauths: [{ status: "approved", validFrom: null, expiresOn: "2026-12-31" }],
    });
    expect(v.reasons).toEqual(["no_patient_pin", "preauth_missing"]);
  });
});
