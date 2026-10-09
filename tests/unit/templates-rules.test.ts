import { describe, expect, it } from "vitest";

import {
  appointmentSlotsUsing,
  canEdit,
  canHardDelete,
  canSubmit,
  EDIT_COOLDOWN_MS,
  isInUse,
  lockedFields,
  submitMode,
  usageSummary,
  type TemplateRow,
} from "@/lib/templates/rules";

const row = (over: Partial<TemplateRow> = {}): TemplateRow => ({
  status: "DRAFT",
  meta_template_id: null,
  archived_at: null,
  last_edited_at: null,
  needs_review: false,
  ...over,
});
const NOW = Date.parse("2026-11-02T12:00:00Z");

describe("canEdit", () => {
  it.each(["DRAFT", "APPROVED", "REJECTED", "PAUSED"])("allows %s", (status) => {
    expect(canEdit(row({ status }), NOW)).toEqual({ ok: true });
  });
  it.each(["PENDING", "IN_APPEAL", "DISABLED", "DELETED", "PENDING_DELETION"])(
    "blocks %s with a reason",
    (status) => {
      const r = canEdit(row({ status }), NOW);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(10);
    },
  );
  it("explains that review is in progress", () => {
    const r = canEdit(row({ status: "PENDING" }), NOW);
    expect(!r.ok && r.reason).toMatch(/reviewing/);
  });
  it("applies the 24 h cooldown to approved templates only", () => {
    const recent = new Date(NOW - 2 * 3_600_000).toISOString();
    const r = canEdit(row({ status: "APPROVED", last_edited_at: recent }), NOW);
    expect(!r.ok && r.reason).toMatch(/22 hour/);
    expect(
      canEdit(
        row({
          status: "APPROVED",
          last_edited_at: new Date(NOW - EDIT_COOLDOWN_MS - 1).toISOString(),
        }),
        NOW,
      ).ok,
    ).toBe(true);
    expect(canEdit(row({ status: "REJECTED", last_edited_at: recent }), NOW).ok).toBe(true);
  });
  it("blocks archived templates", () => {
    expect(canEdit(row({ archived_at: "2026-01-01" }), NOW).ok).toBe(false);
  });
});

describe("canSubmit / submitMode / lockedFields", () => {
  it("requires review of machine-written copy first", () => {
    expect(canSubmit(row({ needs_review: true })).ok).toBe(false);
    expect(canSubmit(row()).ok).toBe(true);
  });
  it("lets a draft, rejected, paused or approved (edit) template go to Meta; nothing else", () => {
    for (const s of ["DRAFT", "REJECTED", "PAUSED", "APPROVED"])
      expect(canSubmit(row({ status: s })).ok).toBe(true);
    for (const s of ["PENDING", "IN_APPEAL", "DELETED", "DISABLED"])
      expect(canSubmit(row({ status: s })).ok).toBe(false);
    expect(canSubmit(row({ archived_at: "2026-01-01" })).ok).toBe(false);
  });
  it("creates when never submitted, edits otherwise", () => {
    expect(submitMode({ meta_template_id: null })).toBe("create");
    expect(submitMode({ meta_template_id: "M1" })).toBe("edit");
  });
  it("locks identity fields once a template exists on Meta, and the category once approved", () => {
    expect(lockedFields({ status: "DRAFT", meta_template_id: null })).toEqual([]);
    expect(lockedFields({ status: "REJECTED", meta_template_id: "M" })).toEqual([
      "name",
      "language",
      "channel",
    ]);
    expect(lockedFields({ status: "APPROVED", meta_template_id: "M" })).toEqual([
      "name",
      "language",
      "channel",
      "category",
    ]);
  });
});

describe("usage", () => {
  const none = { appointmentSlots: [], clinicalKey: null, sendsLast30Days: 0 };
  it("finds the appointment slots that point at a template", () => {
    expect(appointmentSlotsUsing({ reminder: "a", confirmed: "b", cancelled: null }, "a")).toEqual([
      "reminder",
    ]);
    expect(appointmentSlotsUsing(null, "a")).toEqual([]);
  });
  it("summarises and detects use", () => {
    expect(isInUse(none)).toBe(false);
    expect(isInUse({ ...none, clinicalKey: "ABX_DAY3" })).toBe(true);
    expect(
      usageSummary({ appointmentSlots: ["reminder"], clinicalKey: "ABX_DAY3", sendsLast30Days: 3 }),
    ).toEqual([
      "used for appointment reminder messages",
      "used by the clinical rules (ABX_DAY3)",
      "sent 3 time(s) in the last 30 days",
    ]);
  });
  it("hard-deletes only never-submitted, unused drafts", () => {
    expect(canHardDelete({ status: "DRAFT", meta_template_id: null }, none)).toBe(true);
    expect(
      canHardDelete({ status: "DRAFT", meta_template_id: null }, { ...none, sendsLast30Days: 1 }),
    ).toBe(false);
    expect(canHardDelete({ status: "DRAFT", meta_template_id: "M" }, none)).toBe(false);
    expect(canHardDelete({ status: "APPROVED", meta_template_id: "M" }, none)).toBe(false);
  });
});
