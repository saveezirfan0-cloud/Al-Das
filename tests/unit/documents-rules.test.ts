import { describe, expect, it } from "vitest";

import { categoryLabel, isCategory, suggestsExpiry } from "@/lib/documents/categories";
import {
  dayNumber,
  daysUntil,
  dueForExpiryReminder,
  expiryLabel,
  expiryState,
  expiryTaskDue,
  validExpiryDate,
} from "@/lib/documents/expiry";
import {
  classifyRetention,
  pastRetention,
  retentionDueOn,
  validRetainDays,
} from "@/lib/documents/retention";
import { documentMetaSchema, parseTags } from "@/lib/documents/schema";
import {
  DEFAULT_DOCUMENT_SETTINGS,
  readDocumentSettings,
  writeDocumentSettings,
} from "@/lib/documents/settings";

describe("categories", () => {
  it("knows the five categories and asks for an expiry only on insurance cards", () => {
    for (const k of ["referral", "lab_report", "insurance_card", "consent", "other"])
      expect(isCategory(k)).toBe(true);
    expect(isCategory("passport")).toBe(false);
    expect(categoryLabel("lab_report")).toBe("Lab report");
    expect(categoryLabel("zzz")).toBe("Other");
    expect(suggestsExpiry("insurance_card")).toBe(true);
    expect(suggestsExpiry("referral")).toBe(false);
  });
});

describe("expiry", () => {
  it("parses only real calendar dates", () => {
    expect(dayNumber("2026-10-12")).not.toBeNull();
    for (const bad of ["2026-02-30", "2026-13-01", "12/10/2026", "", null, undefined, "2026-1-1"])
      expect(dayNumber(bad)).toBeNull();
  });

  it("counts whole days, across a leap day and a year end", () => {
    expect(daysUntil("2026-10-15", "2026-10-12")).toBe(3);
    expect(daysUntil("2026-10-12", "2026-10-12")).toBe(0);
    expect(daysUntil("2026-10-11", "2026-10-12")).toBe(-1);
    expect(daysUntil("2028-03-01", "2028-02-28")).toBe(2);
    expect(daysUntil("2027-01-01", "2026-12-31")).toBe(1);
    expect(daysUntil(null, "2026-10-12")).toBeNull();
  });

  it("classifies and labels", () => {
    const today = "2026-10-12";
    expect(expiryState(null, today)).toBe("none");
    expect(expiryState("2027-10-12", today)).toBe("valid");
    expect(expiryState("2026-10-26", today, 14)).toBe("expiring");
    expect(expiryState("2026-10-27", today, 14)).toBe("valid");
    expect(expiryState("2026-10-11", today)).toBe("expired");
    expect(expiryLabel("2026-10-12", today)).toBe("Expires today");
    expect(expiryLabel("2026-10-13", today)).toBe("Expires tomorrow");
    expect(expiryLabel("2026-10-20", today)).toBe("Expires in 8 days");
    expect(expiryLabel("2026-10-11", today)).toBe("Expired yesterday");
    expect(expiryLabel("2026-10-01", today)).toBe("Expired 11 days ago");
    expect(expiryLabel(null, today)).toBe("");
  });

  it("selects insurance cards inside the lead time that have not been notified", () => {
    const base = { category: "insurance_card", expiry_notified_at: null };
    const docs = [
      { id: "soon", ...base, expires_on: "2026-10-20" },
      { id: "far", ...base, expires_on: "2027-03-01" },
      { id: "expired", ...base, expires_on: "2026-09-01" },
      { id: "done", ...base, expires_on: "2026-10-20", expiry_notified_at: "2026-10-10T00:00:00Z" },
      { id: "lab", category: "lab_report", expiry_notified_at: null, expires_on: "2026-10-20" },
      { id: "nodate", ...base, expires_on: null },
    ];
    expect(dueForExpiryReminder(docs, "2026-10-12", 14).map((d) => d.id)).toEqual([
      "soon",
      "expired",
    ]);
    expect(dueForExpiryReminder(docs, "2026-10-12", 3).map((d) => d.id)).toEqual(["expired"]);
  });

  it("dates the follow-up task two days before expiry, or now when that has passed", () => {
    const now = new Date("2026-10-12T08:00:00Z");
    expect(expiryTaskDue("2026-10-20", now).toISOString()).toBe("2026-10-18T06:00:00.000Z");
    expect(expiryTaskDue("2026-10-13", now)).toBe(now);
    expect(expiryTaskDue("garbage", now)).toBe(now);
  });

  it("limits what can be typed as an expiry date", () => {
    expect(validExpiryDate("2027-01-01", "2026-10-12")).toBe(true);
    expect(validExpiryDate("1980-01-01", "2026-10-12")).toBe(false);
    expect(validExpiryDate("2099-01-01", "2026-10-12")).toBe(false);
    expect(validExpiryDate("2026-02-31", "2026-10-12")).toBe(false);
  });
});

describe("retention", () => {
  const doc = { created_at: "2026-01-10T10:00:00Z", expires_on: null as string | null };
  it("keeps forever without a policy or days", () => {
    expect(retentionDueOn(null, doc)).toBeNull();
    expect(retentionDueOn({ retain_days: null }, doc)).toBeNull();
    expect(pastRetention({ retain_days: null }, doc, "2099-01-01")).toBe(false);
  });
  it("counts from the upload", () => {
    expect(retentionDueOn({ retain_days: 365 }, doc)).toBe("2027-01-10");
    expect(pastRetention({ retain_days: 365 }, doc, "2027-01-09")).toBe(false);
    expect(pastRetention({ retain_days: 365 }, doc, "2027-01-10")).toBe(true);
  });
  it("counts from the expiry date when that is later (a card is kept after it stops being valid)", () => {
    expect(retentionDueOn({ retain_days: 365 }, { ...doc, expires_on: "2026-06-01" })).toBe(
      "2027-06-01",
    );
    expect(retentionDueOn({ retain_days: 365 }, { ...doc, expires_on: "2025-01-01" })).toBe(
      "2027-01-10",
    );
  });
  it("accepts 30 days to 100 years only", () => {
    for (const d of [30, 365, 36500]) expect(validRetainDays(d)).toBe(true);
    for (const d of [29, 0, -5, 36501, 1.5, "30", null, NaN])
      expect(validRetainDays(d)).toBe(false);
  });
  it("auto-deletes only where the policy says so; everything else goes to review", () => {
    const docs = [
      { id: "a", category: "referral", created_at: "2020-01-01T00:00:00Z", expires_on: null },
      { id: "b", category: "consent", created_at: "2020-01-01T00:00:00Z", expires_on: null },
      { id: "c", category: "other", created_at: "2020-01-01T00:00:00Z", expires_on: null },
      { id: "d", category: "referral", created_at: "2026-10-01T00:00:00Z", expires_on: null },
    ];
    const out = classifyRetention(
      docs,
      [
        { category: "referral", retain_days: 365, auto_delete: true },
        { category: "consent", retain_days: 365, auto_delete: false },
      ],
      "2026-10-12",
    );
    expect(out.autoDelete.map((d) => d.id)).toEqual(["a"]);
    expect(out.review.map((d) => d.id)).toEqual(["b"]);
  });
});

describe("settings and input schemas", () => {
  it("documents are off by default and reads survive junk", () => {
    expect(DEFAULT_DOCUMENT_SETTINGS.enabled).toBe(false);
    expect(readDocumentSettings(null).enabled).toBe(false);
    expect(
      readDocumentSettings({ documents: { enabled: "yes", expiry_lead_days: 9999 } }).enabled,
    ).toBe(false);
    const w = writeDocumentSettings(
      { keep: 1 },
      { ...DEFAULT_DOCUMENT_SETTINGS, enabled: true, expiry_lead_days: 21 },
    );
    expect(w.keep).toBe(1);
    expect(readDocumentSettings(w)).toMatchObject({ enabled: true, expiry_lead_days: 21 });
  });

  it("validates document meta", () => {
    expect(
      documentMetaSchema.safeParse({
        title: " Card ",
        category: "insurance_card",
        expires_on: "2027-01-01",
      }).success,
    ).toBe(true);
    expect(documentMetaSchema.safeParse({ title: "", category: "other" }).success).toBe(false);
    expect(documentMetaSchema.safeParse({ title: "x", category: "passport" }).success).toBe(false);
    expect(
      documentMetaSchema.safeParse({ title: "x", category: "other", expires_on: "soon" }).success,
    ).toBe(false);
  });

  it("cleans tags", () => {
    expect(parseTags(" Offers, offers ,Spring  Sale,,x".replace("x", "a".repeat(40)))).toEqual([
      "offers",
      "spring sale",
    ]);
    expect(parseTags("")).toEqual([]);
    expect(parseTags(Array.from({ length: 20 }, (_, i) => `t${i}`).join(",")).length).toBe(10);
  });
});
