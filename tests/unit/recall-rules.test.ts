import { describe, expect, it } from "vitest";

import {
  ageOn,
  birthdayBand,
  birthdayMonthDays,
  chronicGroupKeys,
  decideRecallSend,
  followUpState,
  parseBands,
  parseGroups,
  parseVisitGapRule,
  pickSendForBooking,
  pickSendForReply,
  primaryChronicGroup,
  resolveSendMode,
  templateForSegment,
  type BirthdayBand,
} from "@/lib/clinical/recall";

const cal = { workingWeekdays: [1, 2, 3, 4, 5, 6], holidays: [] as string[] };

describe("send mode", () => {
  it("is live only for the exact word live", () => {
    expect(resolveSendMode(null, "live")).toBe("live");
    expect(resolveSendMode(null, " LIVE ")).toBe("live");
    expect(resolveSendMode("test", "live")).toBe("test");
    expect(resolveSendMode("live", "test")).toBe("live");
    for (const v of [null, undefined, "", "lve", "yes", "true", "production"])
      expect(resolveSendMode(null, v)).toBe("test");
  });
});

describe("R-20 / R-21 condition groups", () => {
  const g = (key: string, sort: number, messageable = true) => ({ key, sort, messageable });
  it("drops mental-health groups, orders by priority and de-duplicates (BC-26, BC-49)", () => {
    expect(
      chronicGroupKeys([
        g("diabetes", 20),
        g("hypertension", 10),
        g("depression", 5, false),
        g("diabetes", 20),
      ]),
    ).toEqual(["hypertension", "diabetes"]);
    expect(primaryChronicGroup([g("diabetes", 20), g("hypertension", 10)])).toBe("hypertension");
  });
  it("a patient with only non-messageable groups has no primary group", () => {
    expect(primaryChronicGroup([g("anxiety", 1, false)])).toBeNull();
    expect(primaryChronicGroup([])).toBeNull();
  });
  it("ties break by key so the choice is stable", () => {
    expect(primaryChronicGroup([g("b", 10), g("a", 10)])).toBe("a");
  });
  it("parseGroups tolerates junk", () => {
    expect(
      parseGroups([{ key: "x", sort: 3, messageable: true }, { key: "" }, null, 5, { key: "y" }]),
    ).toEqual([
      { key: "x", sort: 3, messageable: true },
      { key: "y", sort: 100, messageable: false },
    ]);
    expect(parseGroups("nope")).toEqual([]);
  });
});

describe("R-23 template per segment", () => {
  const rows = [
    { id: "1", segmentKey: "hypertension", waTemplateId: "t1", active: true },
    { id: "2", segmentKey: "diabetes", waTemplateId: null, active: true },
    { id: "3", segmentKey: "asthma", waTemplateId: "t3", active: false },
  ];
  it("uses only mapped, active rows; there is no default (BC-50)", () => {
    expect(templateForSegment(rows, "hypertension")?.id).toBe("1");
    expect(templateForSegment(rows, "diabetes")).toBeNull();
    expect(templateForSegment(rows, "asthma")).toBeNull();
    expect(templateForSegment(rows, "copd")).toBeNull();
  });
});

describe("birthdays", () => {
  it("age on a date", () => {
    expect(ageOn("1990-10-09", "2026-10-09")).toBe(36);
    expect(ageOn("1990-10-10", "2026-10-09")).toBe(35);
    expect(ageOn("2000-02-29", "2026-02-28")).toBe(25);
    expect(ageOn("bad", "2026-10-09")).toBeNaN();
    expect(ageOn("1990-02-30", "2026-10-09")).toBeNaN();
  });
  it("29 February people are greeted on 1 March in non-leap years only (OQ-18)", () => {
    expect(birthdayMonthDays("2026-03-01")).toEqual(["03-01", "02-29"]);
    expect(birthdayMonthDays("2028-03-01")).toEqual(["03-01"]);
    expect(birthdayMonthDays("2028-02-29")).toEqual(["02-29"]);
    expect(birthdayMonthDays("2100-03-01")).toEqual(["03-01", "02-29"]); // 2100 is not a leap year
    expect(birthdayMonthDays("2026-10-09")).toEqual(["10-09"]);
    expect(birthdayMonthDays("nope")).toEqual([]);
  });
  const bands: BirthdayBand[] = [
    { key: "m_20_29", gender: "male", min_age: 20, max_age: 29 },
    { key: "m_40_plus", gender: "male", min_age: 40 },
    { key: "f_18_35", gender: "female", min_age: 18, max_age: 35 },
  ];
  it("picks the band by gender and age; uncovered patients get nothing", () => {
    expect(birthdayBand(bands, "male", 25)).toBe("m_20_29");
    expect(birthdayBand(bands, "male", 60)).toBe("m_40_plus");
    expect(birthdayBand(bands, "male", 35)).toBeNull(); // gap between bands
    expect(birthdayBand(bands, "male", 19)).toBeNull();
    expect(birthdayBand(bands, "female", 18)).toBe("f_18_35");
    expect(birthdayBand(bands, "female", 36)).toBeNull();
    expect(birthdayBand(bands, "other", 25)).toBeNull();
    expect(birthdayBand(bands, null, 25)).toBeNull();
    expect(birthdayBand(bands, "male", Number.NaN)).toBeNull();
  });
  it("parseBands drops malformed entries", () => {
    expect(
      parseBands({
        bands: [
          { key: "a", gender: "male", min_age: 1 },
          { key: "b", gender: "x" },
          { gender: "male" },
          3,
        ],
      }),
    ).toEqual([{ key: "a", gender: "male", min_age: 1, max_age: undefined }]);
    expect(parseBands(null)).toEqual([]);
    expect(parseBands({})).toEqual([]);
  });
});

describe("visit-gap rule", () => {
  it("reads thresholds from config; a missing minimum means nobody", () => {
    expect(
      parseVisitGapRule({ min_days: 330, gender: "female", min_age: 21, max_age: 65 }),
    ).toEqual({ minDays: 330, maxDays: null, gender: "female", minAge: 21, maxAge: 65 });
    expect(parseVisitGapRule({ min_days: null })).toMatchObject({ minDays: null });
    expect(parseVisitGapRule({ min_days: -5, gender: "x" })).toMatchObject({
      minDays: null,
      gender: null,
    });
    expect(parseVisitGapRule(undefined)).toMatchObject({ minDays: null });
  });
});

describe("decideRecallSend", () => {
  const ok = {
    kind: "chronic",
    gateOpen: true,
    templateMetaStatus: "APPROVED",
    templateClinicalApproval: "approved",
  };
  it("chronic recall needs the open gate, a Meta-approved and a clinically approved template (BC-32)", () => {
    expect(decideRecallSend(ok)).toEqual({ allow: true });
    expect(decideRecallSend({ ...ok, gateOpen: false })).toEqual({
      allow: false,
      reason: "clinical_gate_closed",
    });
    expect(decideRecallSend({ ...ok, templateClinicalApproval: "awaiting" })).toEqual({
      allow: false,
      reason: "template_not_clinically_approved",
    });
    expect(decideRecallSend({ ...ok, templateMetaStatus: "PENDING" })).toEqual({
      allow: false,
      reason: "template_not_approved",
    });
    expect(decideRecallSend({ ...ok, templateMetaStatus: null })).toEqual({
      allow: false,
      reason: "template_not_approved",
    });
  });
  it("marketing programmes do not wait for the clinical gate but still need an approved template", () => {
    expect(
      decideRecallSend({
        kind: "birthday",
        gateOpen: false,
        templateMetaStatus: "APPROVED",
        templateClinicalApproval: "awaiting",
      }),
    ).toEqual({ allow: true });
    expect(
      decideRecallSend({
        kind: "birthday",
        gateOpen: false,
        templateMetaStatus: "REJECTED",
        templateClinicalApproval: "awaiting",
      }),
    ).toEqual({ allow: false, reason: "template_not_approved" });
  });
});

describe("R-24 / R-25 call list", () => {
  const base = {
    sendMode: "live",
    status: "sent",
    sentDate: "2026-10-08",
    repliedAt: null,
    followUpStatus: null,
    daysSinceLastVisitAtSend: 100,
  };
  it("calls after the signed-off number of working days (BC-29)", () => {
    // Thu 8 Oct → Mon 12 Oct: Fri, Sat, Mon = 3 working days on a Mon–Sat week
    expect(followUpState(base, "2026-10-12", cal, { followupWorkdays: 3 })).toMatchObject({
      callNow: true,
      workdaysWaiting: 3,
    });
    expect(followUpState(base, "2026-10-11", cal, { followupWorkdays: 3 })).toMatchObject({
      callNow: false,
      workdaysWaiting: 2,
    });
  });
  it("never calls without a signed-off threshold, in test mode, after a reply or once booked", () => {
    expect(followUpState(base, "2026-10-20", cal, {}).callNow).toBe(false);
    expect(
      followUpState({ ...base, sendMode: "test" }, "2026-10-20", cal, { followupWorkdays: 3 })
        .callNow,
    ).toBe(false);
    expect(
      followUpState({ ...base, repliedAt: "2026-10-09T08:00:00Z" }, "2026-10-20", cal, {
        followupWorkdays: 3,
      }).callNow,
    ).toBe(false);
    expect(
      followUpState({ ...base, followUpStatus: "booked" }, "2026-10-20", cal, {
        followupWorkdays: 3,
      }).callNow,
    ).toBe(false);
    expect(
      followUpState({ ...base, status: "failed" }, "2026-10-20", cal, { followupWorkdays: 3 })
        .callNow,
    ).toBe(false);
    expect(
      followUpState({ ...base, sentDate: null }, "2026-10-20", cal, { followupWorkdays: 3 })
        .callNow,
    ).toBe(false);
  });
  it("overdue is strictly above the threshold and unknown without data (BC-51)", () => {
    expect(
      followUpState({ ...base, daysSinceLastVisitAtSend: 121 }, "2026-10-12", cal, {
        overdueDays: 120,
      }).overdue,
    ).toBe(true);
    expect(
      followUpState({ ...base, daysSinceLastVisitAtSend: 120 }, "2026-10-12", cal, {
        overdueDays: 120,
      }).overdue,
    ).toBe(false);
    expect(
      followUpState({ ...base, daysSinceLastVisitAtSend: null }, "2026-10-12", cal, {
        overdueDays: 120,
      }).overdue,
    ).toBeNull();
    expect(followUpState(base, "2026-10-12", cal, {}).overdue).toBeNull();
  });
});

describe("attribution", () => {
  const at = new Date("2026-10-12T08:00:00Z");
  const s = (
    id: string,
    daysAgo: number,
    extra: Partial<{ repliedAt: string | null; bookedAt: string | null }> = {},
  ) => ({
    id,
    sentAt: new Date(at.getTime() - daysAgo * 86_400_000).toISOString(),
    repliedAt: null,
    bookedAt: null,
    ...extra,
  });
  it("a reply goes to the latest unanswered send inside the window", () => {
    expect(pickSendForReply([s("old", 10), s("new", 2), s("older", 20)], at, 14)?.id).toBe("new");
    expect(pickSendForReply([s("old", 20)], at, 14)).toBeNull();
    expect(
      pickSendForReply([s("done", 2, { repliedAt: "2026-10-11T00:00:00Z" })], at, 14),
    ).toBeNull();
  });
  it("an unsigned window attributes nothing (OQ-22)", () => {
    expect(pickSendForReply([s("a", 1)], at, undefined)).toBeNull();
    expect(pickSendForBooking([s("a", 1)], at, undefined)).toBeNull();
  });
  it("a booking can follow a reply but only once per send", () => {
    expect(pickSendForBooking([s("a", 5, { repliedAt: "2026-10-08T00:00:00Z" })], at, 30)?.id).toBe(
      "a",
    );
    expect(
      pickSendForBooking([s("a", 5, { bookedAt: "2026-10-09T00:00:00Z" })], at, 30),
    ).toBeNull();
    expect(pickSendForBooking([s("a", 45)], at, 30)).toBeNull();
  });
  it("sends in the future or without a date are ignored", () => {
    expect(
      pickSendForReply(
        [
          {
            id: "f",
            sentAt: new Date(at.getTime() + 1000).toISOString(),
            repliedAt: null,
            bookedAt: null,
          },
        ],
        at,
        14,
      ),
    ).toBeNull();
    expect(
      pickSendForReply([{ id: "n", sentAt: null, repliedAt: null, bookedAt: null }], at, 14),
    ).toBeNull();
  });
});
