import { describe, expect, it } from "vitest";

import { and, cond, or, type Filter, type FilterNode } from "@/lib/filters/ast";
import { evaluateFilter, nextAnniversary, type ContactRecord } from "@/lib/filters/evaluate";
import { buildContactFieldRegistry } from "@/lib/filters/field-registry";

const registry = buildContactFieldRegistry({
  customFields: [
    { key: "plan", label: "Plan", type: "select" },
    { key: "visits", label: "Visits", type: "number" },
    { key: "interests", label: "Interests", type: "multi_select" },
    { key: "last_checkup", label: "Last checkup", type: "date" },
    { key: "vip", label: "VIP", type: "boolean" },
  ],
  availableRelations: [
    "contact_tags",
    "segment_members",
    "contact_phones",
    "mentions",
    "enquiries",
  ],
});

const NOW = new Date("2026-10-08T12:00:00Z");

const amina: ContactRecord = {
  columns: {
    full_name: "Amina Test",
    first_name: "Amina",
    last_name: "Test",
    gender: "female",
    nationality: "AE",
    country: "AE",
    phone_e164: "+971500000001",
    email: "amina@example.test",
    dob: "1990-10-10",
    stop_marketing: false,
    promotions_opt_in: true,
    source: "import_csv",
    created_at: "2026-10-01T08:00:00Z",
    last_interaction_at: "2026-10-06T08:00:00Z",
    owner_id: null,
  },
  custom: {
    plan: "axa",
    visits: 4,
    interests: ["derma", "dental"],
    last_checkup: "2025-01-15",
    vip: true,
  },
  relations: {
    contact_tags: [{ tag_id: "t1" }, { tag_id: "t2" }],
    segment_members: [{ segment_id: "s1" }],
    mentions: [{ user_id: "u1" }],
    enquiries: [{ status: "open" }, { status: "won" }],
    contact_phones: [{ phone_e164: "+971500000099" }],
  },
};

const blank: ContactRecord = {
  columns: {
    full_name: "",
    gender: null,
    dob: null,
    stop_marketing: true,
    last_interaction_at: null,
    created_at: "2026-09-01T00:00:00Z",
  },
  custom: { visits: "4" },
  relations: {},
};

function matches(record: ContactRecord, ...nodes: FilterNode[]) {
  return evaluateFilter({ include: and(...nodes) }, registry, record, {
    now: NOW,
    timezone: "Asia/Dubai",
  });
}

describe("in-memory filter evaluator", () => {
  it("handles text operators case-insensitively and blanks", () => {
    expect(matches(amina, cond("full_name", "contains", "amina"))).toBe(true);
    expect(matches(amina, cond("full_name", "eq", "AMINA TEST"))).toBe(true);
    expect(matches(amina, cond("full_name", "starts_with", "Am"))).toBe(true);
    expect(matches(amina, cond("full_name", "ends_with", "xx"))).toBe(false);
    expect(matches(amina, cond("nationality", "in", ["ae", "SA"]))).toBe(true);
    expect(matches(amina, cond("nationality", "not_in", ["AE"]))).toBe(false);
    expect(matches(blank, cond("full_name", "is_empty"))).toBe(true);
    expect(matches(blank, cond("full_name", "not_contains", "x"))).toBe(true);
    expect(matches(blank, cond("gender", "neq", "female"))).toBe(true);
    expect(matches(blank, cond("gender", "eq", "female"))).toBe(false);
  });

  it("handles booleans, selects and users", () => {
    expect(matches(amina, cond("promotions_opt_in", "is_true"))).toBe(true);
    expect(matches(amina, cond("stop_marketing", "is_false"))).toBe(true);
    expect(matches(blank, cond("stop_marketing", "is_true"))).toBe(true);
    expect(matches(amina, cond("source", "in", ["import_csv", "inbox"]))).toBe(true);
    expect(matches(amina, cond("owner", "is_empty"))).toBe(true);
  });

  it("handles dates relative to now in the org timezone", () => {
    expect(matches(amina, cond("last_interaction_at", "within_last", 7))).toBe(true);
    expect(matches(amina, cond("last_interaction_at", "within_last", 1))).toBe(false);
    expect(matches(amina, cond("last_interaction_at", "older_than", 1))).toBe(true);
    expect(matches(blank, cond("last_interaction_at", "older_than", 30))).toBe(false);
    expect(matches(blank, cond("last_interaction_at", "not_within_last", 30))).toBe(true);
    expect(matches(amina, cond("created_at", "on", "2026-10-01"))).toBe(true);
    expect(matches(amina, cond("created_at", "before", "2026-10-02"))).toBe(true);
    expect(matches(amina, cond("created_at", "after", "2026-10-01"))).toBe(false);
    expect(matches(amina, cond("dob", "between", { from: "1990-01-01", to: "1990-12-31" }))).toBe(
      true,
    );
    expect(matches(amina, cond("dob", "between", { from: "1991-01-01" }))).toBe(false);
    // 2026-10-08T12:00Z is 16:00 in Dubai; a timestamp at 22:00Z the day before is already Oct 8 locally
    const edge: ContactRecord = { columns: { created_at: "2026-10-07T22:00:00Z" } };
    expect(matches(edge, cond("created_at", "on", "2026-10-08"))).toBe(true);
  });

  it("handles birthdays", () => {
    expect(nextAnniversary("1990-10-10", "2026-10-08")).toBe("2026-10-10");
    expect(nextAnniversary("1990-10-07", "2026-10-08")).toBe("2027-10-07");
    expect(nextAnniversary("2000-02-29", "2026-02-01")).toBe("2026-02-28");
    expect(matches(amina, cond("birthday", "within_next", 2))).toBe(true);
    expect(matches(amina, cond("birthday", "within_next", 1))).toBe(false);
    expect(matches(amina, cond("birthday", "month_is", 10))).toBe(true);
    expect(matches(amina, cond("birthday", "is_today"))).toBe(false);
    expect(matches(blank, cond("birthday", "is_empty"))).toBe(true);
  });

  it("handles custom fields with type guards", () => {
    expect(matches(amina, cond("custom.plan", "eq", "axa"))).toBe(true);
    expect(matches(amina, cond("custom.visits", "between", { from: 3, to: 5 }))).toBe(true);
    expect(matches(blank, cond("custom.visits", "gte", 1))).toBe(false); // "4" as a string is not a number
    expect(matches(blank, cond("custom.visits", "is_empty"))).toBe(true);
    expect(matches(amina, cond("custom.interests", "has_all", ["derma", "dental"]))).toBe(true);
    expect(matches(amina, cond("custom.interests", "has_none", ["gp"]))).toBe(true);
    expect(matches(blank, cond("custom.interests", "is_empty"))).toBe(true);
    expect(matches(amina, cond("custom.last_checkup", "older_than", 365))).toBe(true);
    expect(matches(amina, cond("custom.vip", "is_true"))).toBe(true);
    expect(matches(blank, cond("custom.vip", "is_false"))).toBe(true);
  });

  it("handles relations: sets, scalar related rows, counts", () => {
    expect(matches(amina, cond("tags", "has_any", ["t2", "t9"]))).toBe(true);
    expect(matches(amina, cond("tags", "has_all", ["t1", "t2"]))).toBe(true);
    expect(matches(amina, cond("tags", "has_all", ["t1", "t3"]))).toBe(false);
    expect(matches(amina, cond("segments", "has_none", ["s1"]))).toBe(false);
    expect(matches(blank, cond("tags", "is_empty"))).toBe(true);
    expect(matches(amina, cond("mentioned_user", "eq", "u1"))).toBe(true);
    expect(matches(amina, cond("enquiry_status", "eq", "won"))).toBe(true);
    expect(matches(amina, cond("enquiry_status", "neq", "won"))).toBe(false);
    expect(matches(blank, cond("enquiry_status", "neq", "won"))).toBe(true);
    expect(matches(amina, cond("enquiry_count", "eq", 2))).toBe(true);
    expect(matches(blank, cond("enquiry_count", "lt", 1))).toBe(true);
    expect(matches(amina, cond("alternate_phone", "contains", "0099"))).toBe(true);
  });

  it("combines and/or groups with the exclusion group", () => {
    const f: Filter = {
      include: and(
        cond("gender", "eq", "female"),
        or(cond("nationality", "eq", "SA"), cond("tags", "has_any", ["t1"])),
      ),
      exclude: and(cond("stop_marketing", "is_true")),
    };
    expect(evaluateFilter(f, registry, amina, { now: NOW })).toBe(true);
    expect(
      evaluateFilter(
        f,
        registry,
        { ...amina, columns: { ...amina.columns, stop_marketing: true } },
        { now: NOW },
      ),
    ).toBe(false);
    expect(evaluateFilter({ include: and() }, registry, blank)).toBe(true);
    expect(evaluateFilter(null, registry, blank)).toBe(true);
  });
});
