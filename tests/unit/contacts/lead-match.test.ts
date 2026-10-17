import { describe, expect, it } from "vitest";

import {
  comparePair,
  decideLeadMatches,
  nationalKey,
  type PersonRef,
} from "@/lib/contacts/lead-match";

const lead = (over: Partial<PersonRef> = {}): PersonRef => ({
  id: "L1",
  fullName: "Layla Demo-01",
  dob: null,
  phone: "+447700900101",
  altPhones: [],
  externalId: null,
  ...over,
});
const patient = (over: Partial<PersonRef> = {}): PersonRef => ({
  id: "P1",
  fullName: "Layla Demo-01",
  dob: "1990-03-04",
  phone: null,
  altPhones: [],
  externalId: "10001",
  ...over,
});

describe("nationalKey", () => {
  it("keeps the last nine digits whatever the formatting", () => {
    expect(nationalKey("+971501234567")).toBe("501234567");
    expect(nationalKey("0501234567")).toBe("501234567");
    expect(nationalKey("00971 50 123 4567")).toBe("501234567");
    expect(nationalKey("12345")).toBeNull();
    expect(nationalKey(null)).toBeNull();
  });
});

describe("comparePair", () => {
  it("only compares a lead (no PIN) with a patient (PIN)", () => {
    expect(comparePair(patient({ id: "x" }), patient())).toBeNull();
    expect(comparePair(lead(), lead({ id: "L2" }))).toBeNull();
    expect(comparePair(lead({ id: "P1" }), patient())).toBeNull();
  });

  it("is HIGH when the name and date of birth are equal, with no phone at all", () => {
    const r = comparePair(lead({ dob: "1990-03-04", phone: null }), patient())!;
    expect(r.confidence).toBe("high");
    expect(r.evidence).toEqual(["name_dob"]);
  });

  it("is HIGH for the same phone plus the same name, however the phone is written", () => {
    const exact = comparePair(
      lead({ phone: "+971501234567" }),
      patient({ phone: "+971501234567" }),
    )!;
    expect(exact.confidence).toBe("high");
    expect(exact.evidence).toEqual(["phone_exact", "name"]);
    // A stray trunk 0 after the country code still shares the last nine digits.
    const national = comparePair(
      lead({ phone: "+971501234567" }),
      patient({ phone: "+9710501234567" }),
    )!;
    expect(national.confidence).toBe("high");
    expect(national.evidence).toEqual(["phone_national", "name"]);
  });

  it("matches a reordered name", () => {
    const r = comparePair(lead({ fullName: "Demo-01 Layla", dob: "1990-03-04" }), patient())!;
    expect(r.confidence).toBe("high");
  });

  it("is MEDIUM for a phone alone when the lead has no name", () => {
    const r = comparePair(
      lead({ fullName: null, phone: "+971501234567" }),
      patient({ phone: "+971501234567", fullName: "Omar Demo-02" }),
    )!;
    expect(r.confidence).toBe("medium");
    expect(r.evidence).toEqual(["phone_exact"]);
  });

  it("is LOW for a phone with the same first name but another surname, and for a name alone", () => {
    expect(
      comparePair(
        lead({ fullName: "Layla Demo-09", phone: "+971501234567" }),
        patient({ phone: "+971501234567" }),
      )!.confidence,
    ).toBe("low");
    expect(comparePair(lead({ phone: null }), patient({ dob: null }))!.confidence).toBe("low");
  });

  it("refuses a different first name on a shared phone (a family), and a different date of birth", () => {
    expect(
      comparePair(
        lead({ fullName: "Sara Demo-01", phone: "+971501234567" }),
        patient({ phone: "+971501234567" }),
      ),
    ).toBeNull();
    expect(comparePair(lead({ dob: "1991-01-01" }), patient())).toBeNull();
  });

  it("treats a one-word name as no name evidence", () => {
    expect(
      comparePair(lead({ fullName: "Layla", phone: null }), patient({ fullName: "Layla" })),
    ).toBeNull();
  });

  it("works from alternate phones on either side", () => {
    const r = comparePair(
      lead({ phone: null, altPhones: ["+971501234567"] }),
      patient({ phone: null, altPhones: ["+971501234567"] }),
    )!;
    expect(r.evidence).toContain("phone_exact");
    expect(r.confidence).toBe("high");
  });
});

describe("decideLeadMatches", () => {
  const p2 = patient({
    id: "P2",
    externalId: "10002",
    fullName: "Layla Demo-01",
    dob: "1985-01-01",
  });

  it("marks every pair of a lead that fits several patients as ambiguous, and picks none", () => {
    const l = lead({ phone: "+971501234567" });
    const a = patient({ phone: "+971501234567", dob: null });
    const b = { ...p2, phone: "+971501234567", dob: null };
    const out = decideLeadMatches(
      [l, a, b],
      [
        { leadId: "L1", patientId: "P1" },
        { leadId: "L1", patientId: "P2" },
      ],
    );
    expect(out).toHaveLength(2);
    expect(out.every((p) => p.ambiguous)).toBe(true);
  });

  it("is not ambiguous when the others are only weak", () => {
    const l = lead({ phone: null, dob: "1990-03-04" });
    const strong = patient();
    const weak = patient({ id: "P3", externalId: "10003", dob: null, fullName: "Layla Demo-01" });
    const out = decideLeadMatches(
      [l, strong, weak],
      [
        { leadId: "L1", patientId: "P1" },
        { leadId: "L1", patientId: "P3" },
      ],
    );
    expect(out.map((p) => [p.patientId, p.confidence, p.ambiguous])).toEqual([
      ["P1", "high", false],
      ["P3", "low", false],
    ]);
  });

  it("ignores unknown ids and repeated pairs, and orders most sure first", () => {
    const out = decideLeadMatches(
      [lead({ dob: "1990-03-04" }), patient()],
      [
        { leadId: "L1", patientId: "P1" },
        { leadId: "L1", patientId: "P1" },
        { leadId: "L1", patientId: "NOPE" },
      ],
    );
    expect(out).toHaveLength(1);
  });
});
