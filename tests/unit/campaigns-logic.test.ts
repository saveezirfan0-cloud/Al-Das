import { describe, expect, it } from "vitest";

import {
  canCancel,
  canPause,
  canResume,
  skipReasonLabel,
  tierDailyLimit,
} from "@/lib/campaigns/constants";
import { funnelStages, parseFunnel, pct, reportCsv } from "@/lib/campaigns/funnel";
import { evaluateGuardrails, parseGuardrails, qualityRank } from "@/lib/campaigns/guardrails";
import {
  classifyRecipient,
  isMarketingCategory,
  parseCsvAudience,
} from "@/lib/campaigns/recipients";
import {
  parseSource,
  resolveVariables,
  sanitizeParam,
  unmappedVariables,
} from "@/lib/campaigns/variables";
import { retryableErrorCodes } from "@/lib/whatsapp/errors";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

const components: MetaTemplateComponent[] = [
  { type: "HEADER", format: "IMAGE", example: { header_handle: ["h"] } },
  {
    type: "BODY",
    text: "Hi {{1}}, your {{2}} is due.",
    example: { body_text: [["Sam", "check-up"]] },
  },
] as unknown as MetaTemplateComponent[];

describe("classifyRecipient", () => {
  const ok = { phone_e164: "+971500000001", promotions_opt_in: true, stop_marketing: false };
  it("allows an opted-in contact for marketing", () => {
    expect(classifyRecipient(ok, { marketing: true })).toBeNull();
  });
  it("fails closed on unknown or blank data", () => {
    expect(classifyRecipient(null, { marketing: false })).toBe("not_found");
    expect(classifyRecipient({}, { marketing: false })).toBe("no_destination");
    expect(classifyRecipient({ phone_e164: "+971500000001" }, { marketing: true })).toBe(
      "no_opt_in",
    );
    expect(
      classifyRecipient(
        { phone_e164: "+971500000001", promotions_opt_in: null },
        { marketing: true },
      ),
    ).toBe("no_opt_in");
  });
  it("honours stop_marketing before opt-in and only for marketing", () => {
    const c = { ...ok, stop_marketing: true };
    expect(classifyRecipient(c, { marketing: true })).toBe("stop_marketing");
    expect(classifyRecipient(c, { marketing: false })).toBeNull();
  });
  it("accepts BSUID-only contacts and rejects deleted ones", () => {
    expect(classifyRecipient({ wa_bsuid: "u1" }, { marketing: false })).toBeNull();
    expect(classifyRecipient({ ...ok, deleted_at: "2026-01-01" }, { marketing: false })).toBe(
      "deleted",
    );
  });
  it("detects marketing templates", () => {
    expect(isMarketingCategory("MARKETING")).toBe(true);
    expect(isMarketingCategory("marketing")).toBe(true);
    expect(isMarketingCategory("UTILITY")).toBe(false);
    expect(isMarketingCategory(null)).toBe(false);
  });
});

describe("variables", () => {
  it("parses sources", () => {
    expect(parseSource("contact.first_name")).toEqual({ kind: "contact", field: "first_name" });
    expect(parseSource("custom.plan")).toEqual({ kind: "custom", key: "plan" });
    expect(parseSource("csv.visit")).toEqual({ kind: "csv", column: "visit" });
    expect(parseSource("text:https://x.test/a.png")).toEqual({
      kind: "text",
      value: "https://x.test/a.png",
    });
    expect(parseSource("contact.password")).toBeNull();
    expect(parseSource("")).toBeNull();
  });

  it("resolves from contact, csv, text and fallbacks", () => {
    const r = resolveVariables({
      components,
      map: {
        "body.1": "contact.first_name",
        "body.2": "csv.reason",
        "header.media": "text:https://x.test/a.png",
      },
      contact: { first_name: "Sam" },
      csv: { reason: "check-up" },
    });
    expect(r.values).toEqual({
      "body.1": "Sam",
      "body.2": "check-up",
      "header.media": "https://x.test/a.png",
    });
    expect(r.missing).toEqual([]);
  });

  it("uses fallbacks for blanks and reports what is still missing", () => {
    const r = resolveVariables({
      components,
      map: { "body.1": "contact.first_name", "body.2": "custom.nothing", "header.media": "text:u" },
      fallbacks: { "body.1": "there" },
      contact: { first_name: "  " },
    });
    expect(r.values["body.1"]).toBe("there");
    expect(r.missing).toEqual(["body.2"]);
  });

  it("falls back to the template's own map and the WhatsApp profile name", () => {
    const r = resolveVariables({
      components,
      map: {},
      templateMap: {
        "body.1": "contact.first_name",
        "body.2": "text:visit",
        "header.media": "text:u",
      },
      contact: { first_name: "", wa_profile_name: "Alex Doe" },
    });
    expect(r.values["body.1"]).toBe("Alex");
  });

  it("sanitises values Meta would reject", () => {
    expect(sanitizeParam("a\nb\tc")).toBe("a b c");
    expect(sanitizeParam("a      b")).toBe("a   b");
    expect(sanitizeParam("x".repeat(2000)).length).toBe(1024);
  });

  it("lists unmapped variables", () => {
    expect(
      unmappedVariables(components, { "body.1": "contact.first_name" }).map((v) => v.key),
    ).toEqual(["header.media", "body.2"]);
  });
});

describe("parseCsvAudience", () => {
  it("normalises phones, dedupes and keeps extra columns", () => {
    const r = parseCsvAudience(
      "Mobile,First Name,Visit date\n0501234567,Sam,Monday\n+971 50 123 4567,Dup,Tue\nnope,X,Y\n,,\n0509876543,,Wed\n",
    );
    if ("error" in r) throw new Error(r.error);
    expect(r.rows.map((x) => x.phone_e164)).toEqual(["+971501234567", "+971509876543"]);
    expect(r.rows[0].data).toMatchObject({ first_name: "Sam", visit_date: "Monday" });
    expect(r.columns).toEqual(["first_name", "visit_date"]);
    expect(r.duplicates).toBe(1);
    expect(r.rejected).toEqual([{ line: 4, reason: "Not a valid phone number" }]);
  });
  it("splits a single name column", () => {
    const r = parseCsvAudience("phone,name\n0501234567,Sam Lee Jr\n");
    if ("error" in r) throw new Error(r.error);
    expect(r.rows[0]).toMatchObject({ first_name: "Sam", last_name: "Lee Jr" });
  });
  it("errors without a phone column and caps the audience", () => {
    expect(parseCsvAudience("email\na@b.test\n")).toHaveProperty("error");
    expect(parseCsvAudience("")).toHaveProperty("error");
    const r = parseCsvAudience("phone\n0501234567\n0501234568\n0501234569\n", { maxRows: 2 });
    if ("error" in r) throw new Error(r.error);
    expect(r.rows).toHaveLength(2);
    expect(r.tooMany).toBe(true);
  });
});

describe("guardrails", () => {
  const base = {
    guardrails: parseGuardrails({}),
    sentSince: 0,
    failedByCode: [],
    channel: { status: "active", quality_rating: "GREEN" },
    qualityAtStart: "GREEN",
    template: { status: "APPROVED" },
  };

  it("bounds stored values", () => {
    expect(parseGuardrails({ max_failure_pct: 500, min_sample: 1 })).toMatchObject({
      max_failure_pct: 100,
      min_sample: 5,
    });
    expect(parseGuardrails(null).pause_on_quality_drop).toBe(true);
  });

  it("does not pause a healthy campaign", () => {
    expect(
      evaluateGuardrails({ ...base, sentSince: 500, failedByCode: [{ code: 131026, count: 5 }] }),
    ).toEqual({
      pause: false,
    });
  });

  it("waits for the minimum sample before applying percentages", () => {
    expect(
      evaluateGuardrails({ ...base, sentSince: 5, failedByCode: [{ code: 131000, count: 20 }] }),
    ).toEqual({
      pause: false,
    });
  });

  it("pauses on a systemic failure spike", () => {
    const v = evaluateGuardrails({
      ...base,
      sentSince: 70,
      failedByCode: [{ code: 131000, count: 30 }],
    });
    expect(v).toMatchObject({ pause: true, code: "failure_spike" });
  });

  it("pauses on a bad list even when failures are the recipients' fault", () => {
    const v = evaluateGuardrails({
      ...base,
      sentSince: 50,
      failedByCode: [{ code: 131026, count: 50 }],
    });
    expect(v).toMatchObject({ pause: true, code: "bad_list" });
  });

  it("pauses at once on auth / account errors", () => {
    const v = evaluateGuardrails({
      ...base,
      sentSince: 1,
      failedByCode: [{ code: 131005, count: 3 }],
    });
    expect(v).toMatchObject({ pause: true, code: "account_errors" });
  });

  it("pauses on a quality drop, a paused number or an unapproved template", () => {
    expect(
      evaluateGuardrails({ ...base, channel: { status: "active", quality_rating: "YELLOW" } }),
    ).toMatchObject({ pause: true, code: "quality_drop" });
    expect(
      evaluateGuardrails({
        ...base,
        qualityAtStart: null,
        channel: { status: "active", quality_rating: "RED" },
      }),
    ).toMatchObject({ pause: true, code: "quality_drop" });
    expect(
      evaluateGuardrails({ ...base, channel: { status: "paused", quality_rating: "GREEN" } }),
    ).toMatchObject({
      pause: true,
      code: "channel_inactive",
    });
    expect(evaluateGuardrails({ ...base, template: { status: "PAUSED" } })).toMatchObject({
      pause: true,
      code: "template_unavailable",
    });
  });

  it("can ignore quality drops when configured", () => {
    expect(
      evaluateGuardrails({
        ...base,
        guardrails: parseGuardrails({ pause_on_quality_drop: false }),
        channel: { status: "active", quality_rating: "RED" },
      }),
    ).toEqual({ pause: false });
  });

  it("ranks quality", () => {
    expect(qualityRank("GREEN")).toBeGreaterThan(qualityRank("YELLOW")!);
    expect(qualityRank("UNKNOWN")).toBeNull();
  });
});

describe("funnel and report", () => {
  it("parses and computes percentages of the eligible audience", () => {
    const f = parseFunnel({
      total: 120,
      eligible: 100,
      sent: 90,
      delivered: 80,
      read: 40,
      replied: 10,
      failed: 10,
      skipped: 20,
    });
    const stages = funnelStages(f);
    expect(stages.map((s) => [s.key, s.count, s.pct])).toEqual([
      ["total", 100, 100],
      ["sent", 90, 90],
      ["delivered", 80, 80],
      ["read", 40, 40],
      ["replied", 10, 10],
      ["failed", 10, 10],
    ]);
    expect(pct(1, 3)).toBe(33.3);
    expect(pct(1, 0)).toBe(0);
    expect(parseFunnel(null).total).toBe(0);
    expect(parseFunnel({ total: "x", sent: -4 }).sent).toBe(0);
  });

  it("builds a CSV report and neutralises formula injection", () => {
    const csv = reportCsv([
      {
        name: "=SUM(A1)",
        phone: "+971500000001",
        status: "skipped",
        skip_reason: "no_opt_in",
        round: 0,
        sent_at: null,
        delivered_at: null,
        read_at: null,
        replied_at: null,
        error_code: null,
        error_message: null,
      },
    ]);
    expect(csv).toContain("Name,Phone,Status");
    expect(csv).toContain("'=SUM(A1)");
    expect(csv).toContain("No marketing opt-in");
  });
});

describe("status helpers and limits", () => {
  it("gates transitions", () => {
    expect(canPause("sending")).toBe(true);
    expect(canPause("completed")).toBe(false);
    expect(canResume("paused")).toBe(true);
    expect(canCancel("completed")).toBe(false);
    expect(canCancel("scheduled")).toBe(true);
  });
  it("maps tiers and skip reasons", () => {
    expect(tierDailyLimit("TIER_1K")).toBe(1000);
    expect(tierDailyLimit("TIER_UNLIMITED")).toBeNull();
    expect(tierDailyLimit(null)).toBeNull();
    expect(skipReasonLabel("missing_variable:body.1")).toBe("Missing template value (body.1)");
    expect(skipReasonLabel(null)).toBe("");
  });
  it("retries only transient/rate-limit codes", () => {
    const codes = retryableErrorCodes();
    expect(codes).toContain(130429);
    expect(codes).toContain(503);
    expect(codes).not.toContain(131026);
    expect(codes).not.toContain(131050);
  });
});
