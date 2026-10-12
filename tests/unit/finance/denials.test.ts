import { describe, expect, it } from "vitest";

import {
  ACTIVE_STATUSES,
  CASE_STATUSES,
  canMoveCase,
  caseDefaults,
  closeNeedsNote,
  deadlineCountdown,
  deadlineFor,
  dueForDeadlineReminder,
  familyOf,
  lookupDenialCode,
  nextCaseStatuses,
  type DenialCodeRow,
} from "@/lib/finance/denials";

import fixture from "./fixtures/phase18-denials.synthetic.json";

const taxonomy = fixture.taxonomy as DenialCodeRow[];

describe("denial taxonomy", () => {
  it("takes the family from the leading letters", () => {
    expect(familyOf("MNEC-003")).toBe("MNEC");
    expect(familyOf(" auth01")).toBe("AUTH");
    expect(familyOf("12345")).toBeNull();
    expect(familyOf(null)).toBeNull();
  });

  for (const l of fixture.lookups) {
    it(`looks up ${String(l.code)}`, () => {
      const row = lookupDenialCode(l.code, taxonomy);
      expect(row?.code ?? null).toBe(l.expectCode);
      const d = caseDefaults(l.code, taxonomy, fixture.defaultResubmitDays);
      expect(d.category).toBe(l.expectCategory);
      expect(d.ownerRole).toBe(l.expectOwner);
      expect(d.resubmitDays).toBe(l.expectDays);
      expect(d.taxonomyMatch).toBe(l.expectCode !== null);
    });
  }

  it("prefers the exact code over its family", () => {
    expect(lookupDenialCode("MNEC-003", taxonomy)?.isFamily).toBe(false);
    expect(lookupDenialCode("MNEC-004", taxonomy)?.isFamily).toBe(true);
  });
});

describe("deadline and countdown", () => {
  it("adds the window to the denial date", () => {
    expect(deadlineFor("2026-10-01", 30)).toBe("2026-10-31");
    expect(deadlineFor("2026-12-20", 30)).toBe("2027-01-19");
  });

  it("counts down and goes overdue", () => {
    expect(deadlineCountdown("2026-10-31", "2026-10-01", 7)).toMatchObject({
      state: "ok",
      daysLeft: 30,
    });
    expect(deadlineCountdown("2026-10-31", "2026-10-24", 7)).toMatchObject({
      state: "soon",
      daysLeft: 7,
      label: "7 days left",
    });
    expect(deadlineCountdown("2026-10-31", "2026-10-31", 7)).toMatchObject({
      state: "soon",
      label: "Due today",
    });
    expect(deadlineCountdown("2026-10-31", "2026-11-01", 7)).toMatchObject({
      state: "overdue",
      label: "1 day overdue",
    });
    expect(deadlineCountdown("2026-10-31", "2026-11-10", 7)).toMatchObject({
      state: "overdue",
      label: "10 days overdue",
    });
  });
});

describe("case workflow", () => {
  it("never leaves a closed state and never loops to itself", () => {
    for (const s of CASE_STATUSES) {
      expect(canMoveCase(s, s)).toBe(false);
      if (!ACTIVE_STATUSES.includes(s)) expect(nextCaseStatuses(s)).toEqual([]);
    }
  });
  it("lets the team move a case but not mark it recovered (system only)", () => {
    for (const s of ACTIVE_STATUSES) expect(canMoveCase(s, "recovered")).toBe(false);
    expect(canMoveCase("open", "appealed")).toBe(true);
    expect(canMoveCase("appealed", "won")).toBe(true);
    expect(canMoveCase("open", "won")).toBe(false);
  });
  it("needs a note to close", () => {
    expect(closeNeedsNote("lost")).toBe(true);
    expect(closeNeedsNote("written_off")).toBe(true);
    expect(closeNeedsNote("appealed")).toBe(false);
  });
});

describe("deadline reminders", () => {
  const cases = [
    { id: "a", status: "open", deadline_on: "2026-10-25", deadline_notified_at: null },
    { id: "b", status: "in_progress", deadline_on: "2026-10-10", deadline_notified_at: null },
    {
      id: "c",
      status: "open",
      deadline_on: "2026-10-25",
      deadline_notified_at: "2026-10-19T00:00:00Z",
    },
    { id: "d", status: "appealed", deadline_on: "2026-10-22", deadline_notified_at: null },
    { id: "e", status: "open", deadline_on: "2026-12-25", deadline_notified_at: null },
  ];
  it("reminds only worked cases inside the window (overdue included), once", () => {
    expect(dueForDeadlineReminder(cases, "2026-10-20", 7).map((c) => c.id)).toEqual(["a", "b"]);
  });
});
