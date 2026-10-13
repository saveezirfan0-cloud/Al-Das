import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  INTEGRATIONS,
  integrationDef,
  needsConfirmation,
  validateFields,
  allFields,
} from "@/lib/integrations/catalog";
import { readinessProblems } from "@/lib/integrations/readiness";
import {
  MAX_REVIEW_AGE_MS,
  parseReviewVariableMap,
  readReviewConfig,
} from "@/lib/integrations/reviews/config";
import {
  reviewDecision,
  visitIsFinished,
  type PersonFacts,
  type ReviewDecisionInput,
} from "@/lib/integrations/reviews/decision";
import {
  nextSendTime,
  reviewRunAt,
  sendingHours,
  visitEnd,
} from "@/lib/integrations/reviews/schedule";
import { validateReviewUrl } from "@/lib/integrations/reviews/url";
import { firstName, reviewValues } from "@/lib/integrations/reviews/values";
import { isWithinOfficeHours } from "@/lib/flow-engine/office-hours";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

describe("review link validation", () => {
  it("accepts Google's own https hosts", () => {
    for (const u of [
      "https://g.page/r/CabcDEF123/review",
      "https://search.google.com/local/writereview?placeid=ChIJxyz",
      "https://www.google.com/maps/place/Clinic/@25.2,55.3,17z",
      "https://google.com/maps?cid=123",
      "https://maps.app.goo.gl/AbCdEf123",
      "  https://g.page/r/x/review  ",
    ])
      expect(validateReviewUrl(u), u).toMatchObject({ ok: true });
    expect(validateReviewUrl("https://g.page/r/x/review")).toEqual({
      ok: true,
      url: "https://g.page/r/x/review",
    });
  });

  it("refuses everything else: other hosts, look-alikes, http, credentials, ports, spaces, junk", () => {
    for (const u of [
      "",
      "   ",
      "not a url",
      "http://g.page/r/x/review",
      "https://evil.example/g.page/r/x",
      "https://g.page.evil.example/r/x",
      "https://evil-g.page/r/x",
      "https://google.com.evil.example/",
      "https://notgoogle.com/",
      "https://goo.gl/abc",
      "https://user:pw@g.page/r/x",
      "https://g.page:8443/r/x",
      "https://g.page/r/x y",
      "javascript:alert(1)",
      "data:text/html,hi",
      "https://127.0.0.1/",
      "https://g.page/r/\u0000",
      "https://g.page/" + "a".repeat(600),
    ])
      expect(validateReviewUrl(u).ok, u).toBe(false);
    expect(validateReviewUrl(undefined).ok).toBe(false);
    expect(validateReviewUrl(42).ok).toBe(false);
  });
});

describe("review settings", () => {
  it("reads defaults and repairs bad values", () => {
    expect(readReviewConfig({})).toEqual({
      delayMinutes: 120,
      sendFrom: "09:00",
      sendTo: "20:00",
      capDays: 90,
      templateId: null,
      variableMap: {},
    });
    expect(
      readReviewConfig({ delay_minutes: 5, cap_days: 3, send_from: "25:00", send_to: "xx" }),
    ).toMatchObject({ delayMinutes: 120, capDays: 90, sendFrom: "09:00", sendTo: "20:00" });
    // a window that closes before it opens would never send
    expect(readReviewConfig({ send_from: "18:00", send_to: "09:00" })).toMatchObject({
      sendFrom: "09:00",
      sendTo: "20:00",
    });
    expect(readReviewConfig({ delay_minutes: 30, cap_days: 30, template_id: "t1" })).toMatchObject({
      delayMinutes: 30,
      capDays: 30,
      templateId: "t1",
    });
  });

  it("keeps only known sources in the variable map", () => {
    expect(
      parseReviewVariableMap(
        JSON.stringify({ "body.1": "first_name", "body.2": "review_link", "body.3": "dob" }),
      ),
    ).toEqual({ "body.1": "first_name", "body.2": "review_link" });
    expect(parseReviewVariableMap("not json")).toEqual({});
    expect(parseReviewVariableMap(undefined)).toEqual({});
  });

  it("validates the form fields (24-hour times, ranges) and defaults", () => {
    const fields = allFields("google_reviews", "link");
    expect(validateFields(fields, {})).toEqual({
      ok: true,
      secrets: {},
      config: { delay_minutes: 120, send_from: "09:00", send_to: "20:00", cap_days: 90 },
    });
    expect(validateFields(fields, { send_from: "9am" })).toMatchObject({ ok: false });
    expect(validateFields(fields, { cap_days: 3 })).toMatchObject({ ok: false });
    expect(validateFields(fields, { delay_minutes: 10 })).toMatchObject({ ok: false });
    expect(validateFields(fields, { send_to: "23:59", cap_days: 365 })).toMatchObject({ ok: true });
  });
});

describe("catalogue entry", () => {
  it("is a patient-contacting integration with a typed confirmation and no provider call", () => {
    const d = integrationDef("google_reviews");
    expect(d.outbound).toBe(false);
    expect(d.contactsPatients).toBe(true);
    expect(needsConfirmation("google_reviews")).toBe(true);
    expect(d.confirmWord).toBe("ENABLE REVIEW REQUESTS");
    expect(d.providers.flatMap((p) => p.fields.filter((f) => f.secret))).toEqual([]);
    expect(INTEGRATIONS.some((i) => i.kind === "google_reviews")).toBe(true);
  });

  it("is ready only with an approved, fully mapped template carrying the link and at least one location link", () => {
    const base = {
      kind: "google_reviews" as const,
      provider: "link",
      config: {},
      secretsStored: {},
    };
    const good = {
      status: "APPROVED",
      category: "MARKETING",
      mappedAll: true,
      hasLinkVariable: true,
      unsupported: false,
    };
    expect(
      readinessProblems({ ...base, reviews: { template: good, locationsWithLink: 1 } }),
    ).toEqual([]);
    expect(readinessProblems(base)).toEqual([
      "Choose the WhatsApp template used for the review request.",
      "Add the Google review link of at least one location.",
    ]);
    expect(
      readinessProblems({
        ...base,
        reviews: { template: { ...good, status: "PENDING" }, locationsWithLink: 1 },
      }),
    ).toContain("The review template is not approved by Meta.");
    expect(
      readinessProblems({
        ...base,
        reviews: { template: { ...good, hasLinkVariable: false }, locationsWithLink: 1 },
      }),
    ).toContain("Map one variable of the review template to the review link.");
    expect(
      readinessProblems({ ...base, reviews: { template: good, locationsWithLink: 0 } }),
    ).toEqual(["Add the Google review link of at least one location."]);
    // a Marketing template is fine here (only opted-in patients are asked); Utility is not required
    expect(
      readinessProblems({
        ...base,
        reviews: { template: { ...good, category: "UTILITY" }, locationsWithLink: 2 },
      }),
    ).toEqual([]);
  });
});

describe("sending window", () => {
  const tz = "Asia/Dubai"; // UTC+4, no daylight saving
  const win = { timezone: tz, from: "09:00", to: "20:00" };

  it("sends at once inside the window", () => {
    const t = new Date("2026-10-19T08:30:00Z"); // 12:30 in Dubai
    expect(nextSendTime(t, win)).toEqual(t);
  });

  it("waits for the opening when it is too early, the same day", () => {
    const t = new Date("2026-10-19T02:00:00Z"); // 06:00 in Dubai
    expect(nextSendTime(t, win).toISOString()).toBe("2026-10-19T05:00:00.000Z"); // 09:00 Dubai
  });

  it("waits for tomorrow's opening when it is too late", () => {
    const t = new Date("2026-10-19T17:30:00Z"); // 21:30 in Dubai
    expect(nextSendTime(t, win).toISOString()).toBe("2026-10-20T05:00:00.000Z");
    // exactly at closing time is outside (the end is exclusive)
    expect(nextSendTime(new Date("2026-10-19T16:00:00Z"), win).toISOString()).toBe(
      "2026-10-20T05:00:00.000Z",
    );
  });

  it("uses the same office-hours function the flow engine uses, for every day of the week", () => {
    const hours = sendingHours(tz, "09:00", "20:00");
    for (const d of ["2026-10-19", "2026-10-20", "2026-10-24", "2026-10-25"])
      expect(isWithinOfficeHours(hours, new Date(`${d}T08:00:00Z`))).toBe(true);
    expect(isWithinOfficeHours(hours, new Date("2026-10-19T01:00:00Z"))).toBe(false);
  });

  it("plans the run time as visit end plus delay, never in the past", () => {
    const now = new Date("2026-10-19T09:00:00Z");
    // visit ended 10:00 Dubai (06:00Z) -> +2h = 12:00 Dubai (08:00Z) is already past, so now (13:00 Dubai, inside the window)
    expect(reviewRunAt(new Date("2026-10-19T06:00:00Z"), 120, win, now).toISOString()).toBe(
      "2026-10-19T09:00:00.000Z",
    );
    // visit just ended -> two hours from now, inside the window
    expect(reviewRunAt(new Date("2026-10-19T08:55:00Z"), 120, win, now).toISOString()).toBe(
      "2026-10-19T10:55:00.000Z",
    );
    // visit ended 19:00 Dubai (15:00Z) -> +2h = 21:00 Dubai, outside -> tomorrow 09:00
    expect(
      reviewRunAt(
        new Date("2026-10-19T15:00:00Z"),
        120,
        win,
        new Date("2026-10-19T15:05:00Z"),
      ).toISOString(),
    ).toBe("2026-10-20T05:00:00.000Z");
  });

  it("measures the end of the visit from check-out, then done, then the booked end", () => {
    const now = new Date("2026-10-19T10:00:00Z");
    const base = { checked_out_at: null, done_at: null, ends_at: "2026-10-19T09:00:00Z" };
    expect(visitEnd(base, now).toISOString()).toBe("2026-10-19T09:00:00.000Z");
    expect(visitEnd({ ...base, done_at: "2026-10-19T08:40:00Z" }, now).toISOString()).toBe(
      "2026-10-19T08:40:00.000Z",
    );
    expect(
      visitEnd(
        { ...base, done_at: "2026-10-19T08:40:00Z", checked_out_at: "2026-10-19T08:50:00Z" },
        now,
      ).toISOString(),
    ).toBe("2026-10-19T08:50:00.000Z");
    // completed early (before the booked end): the end is now
    expect(visitEnd({ ...base, ends_at: "2026-10-19T12:00:00Z" }, now)).toEqual(now);
  });
});

describe("who is asked", () => {
  const person = (over: PersonFacts = {}): PersonFacts => ({
    promotions_opt_in: true,
    stop_marketing: false,
    ...over,
  });
  const now = new Date("2026-10-19T12:00:00Z");
  const input = (over: Partial<ReviewDecisionInput> = {}): ReviewDecisionInput => ({
    appointment: { status: "completed", checkin_status: null, hasPatient: true },
    patient: person(),
    recipient: person(),
    link: "https://g.page/r/x/review",
    now,
    visitEndedAt: new Date("2026-10-19T09:00:00Z"),
    maxAgeMs: MAX_REVIEW_AGE_MS,
    ...over,
  });
  const reason = (over: Partial<ReviewDecisionInput>) => {
    const d = reviewDecision(input(over));
    return d.allow ? "allowed" : d.reason;
  };

  it("asks an opted-in patient after a completed visit", () => {
    expect(reviewDecision(input())).toEqual({ allow: true });
  });

  it("counts a visit as finished when completed or checked out; never when cancelled or a no-show", () => {
    expect(visitIsFinished({ status: "completed", checkin_status: null })).toBe(true);
    expect(visitIsFinished({ status: "confirmed", checkin_status: "checked_out" })).toBe(true);
    expect(visitIsFinished({ status: "confirmed", checkin_status: "done" })).toBe(false);
    expect(visitIsFinished({ status: "awaiting", checkin_status: null })).toBe(false);
    expect(visitIsFinished({ status: "cancelled", checkin_status: "checked_out" })).toBe(false);
    expect(visitIsFinished({ status: "no_show", checkin_status: null })).toBe(false);
    expect(
      reason({ appointment: { status: "cancelled", checkin_status: null, hasPatient: true } }),
    ).toBe("visit_not_completed");
  });

  it("needs explicit opt-in and respects stop marketing, for the patient and for the person messaged", () => {
    expect(reason({ recipient: person({ promotions_opt_in: false }) })).toBe("no_opt_in");
    expect(reason({ recipient: person({ promotions_opt_in: null }) })).toBe("no_opt_in");
    expect(reason({ recipient: person({ stop_marketing: true }) })).toBe("stop_marketing");
    // a guardian is messaged, but the child's own stop-marketing is respected too
    expect(reason({ patient: person({ stop_marketing: true }) })).toBe("stop_marketing");
  });

  it("honours the staff 'do not ask' switch on the patient or the guardian", () => {
    expect(reason({ patient: person({ no_review_requests_at: "2026-10-01T00:00:00Z" }) })).toBe(
      "do_not_ask",
    );
    expect(reason({ recipient: person({ no_review_requests_at: "2026-10-01T00:00:00Z" }) })).toBe(
      "do_not_ask",
    );
  });

  it("never asks test records or erased, deleted and merged ones", () => {
    expect(reason({ patient: person({ is_test_record: true }) })).toBe("test_record");
    expect(reason({ patient: person({ erased_at: "2026-10-01T00:00:00Z" }) })).toBe(
      "patient_unavailable",
    );
    expect(reason({ patient: person({ deleted_at: "2026-10-01T00:00:00Z" }) })).toBe(
      "patient_unavailable",
    );
    expect(reason({ recipient: person({ merged_into_id: "x" }) })).toBe("patient_unavailable");
  });

  it("needs a way to reach the person, a link, and a request that is not stale", () => {
    expect(reason({ recipient: null })).toBe("no_recipient");
    expect(reason({ link: null })).toBe("no_link");
    expect(reason({ patient: null })).toBe("no_patient");
    expect(
      reason({ appointment: { status: "completed", checkin_status: null, hasPatient: false } }),
    ).toBe("no_patient");
    expect(reason({ visitEndedAt: new Date(now.getTime() - MAX_REVIEW_AGE_MS - 1) })).toBe(
      "too_late",
    );
    expect(reason({ visitEndedAt: new Date(now.getTime() - MAX_REVIEW_AGE_MS + 60_000) })).toBe(
      "allowed",
    );
  });

  it("is blind to how the visit went: no review gating (Google's policy)", () => {
    // The decision function's inputs are consent, record status and the link. Nothing about sentiment, complaints, AI tags,
    // ratings or satisfaction can be passed to it, and its source never mentions them.
    const src = readFileSync(
      join(__dirname, "../../../lib/integrations/reviews/decision.ts"),
      "utf8",
    );
    const code = src
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(code).not.toMatch(
      /sentiment|complaint|ai_tags|rating|satisf|emergency|feedback|score|nps/i,
    );
    const extra = {
      ...input(),
      complaint: true,
      ai_tags: ["complaint"],
      sentiment: -1,
    } as ReviewDecisionInput;
    expect(reviewDecision(extra)).toEqual({ allow: true });
  });
});

describe("review message values", () => {
  const comps: MetaTemplateComponent[] = [
    {
      type: "BODY",
      text: "Hi {{1}}, thank you for visiting {{2}}. Review us: {{3}}",
      example: { body_text: [["Sara", "Clinic", "https://g.page/r/x"]] },
    },
  ] as never;

  it("fills only from the closed set and reports what is missing", () => {
    const ctx = {
      first_name: "Layla",
      patient_first_name: "Omar",
      clinic_name: "Jumeirah",
      review_link: "https://g.page/r/x/review",
    };
    const ok = reviewValues(
      comps,
      { "body.1": "first_name", "body.2": "clinic_name", "body.3": "review_link" },
      ctx,
    );
    expect(ok.values).toEqual({
      "body.1": "Layla",
      "body.2": "Jumeirah",
      "body.3": "https://g.page/r/x/review",
    });
    expect(ok.missing).toEqual([]);
    expect(ok.hasLink).toBe(true);
    const bad = reviewValues(
      comps,
      { "body.1": "first_name", "body.2": "contact.last_name", "body.3": "dob" },
      ctx,
    );
    expect(bad.missing.sort()).toEqual(["body.2", "body.3"]);
    expect(bad.hasLink).toBe(false);
    expect(Object.values(bad.values)).toEqual(["Layla"]);
  });

  it("takes the first word of a name only", () => {
    expect(firstName("  Sara Ahmed Khan ")).toBe("Sara");
    expect(firstName(null)).toBe("");
  });
});
