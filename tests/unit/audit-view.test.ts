import { describe, expect, it } from "vitest";

import {
  ACTIVITY_PAGE_SIZE,
  actionTone,
  describeAction,
  diffPreview,
  parseActivityFilters,
  periodStart,
} from "@/lib/audit-view";

describe("parseActivityFilters", () => {
  it("defaults to the last 7 days, first page, no filters", () => {
    expect(parseActivityFilters({})).toEqual({
      period: "7d",
      entity: null,
      actor: null,
      q: null,
      page: 1,
    });
  });

  it("accepts valid values and ignores array duplicates", () => {
    const actor = "123e4567-e89b-12d3-a456-426614174000";
    const f = parseActivityFilters({
      period: ["30d", "24h"],
      entity: "role",
      actor,
      q: "export",
      page: "3",
    });
    expect(f).toMatchObject({ period: "30d", entity: "role", actor, q: "export", page: 3 });
  });

  it("drops anything unsafe instead of throwing", () => {
    const f = parseActivityFilters({
      period: "forever",
      entity: "role; drop table",
      actor: "not-a-uuid",
      q: "50%_off,(x)",
      page: "-4",
    });
    expect(f.period).toBe("7d");
    expect(f.entity).toBeNull();
    expect(f.actor).toBeNull();
    expect(f.q).toBe("50 off x");
    expect(f.page).toBe(1);
  });

  it("caps the search text and rejects absurd page numbers", () => {
    expect(parseActivityFilters({ q: "a".repeat(200) }).q).toHaveLength(64);
    expect(parseActivityFilters({ page: "99999999" }).page).toBe(1);
    expect(ACTIVITY_PAGE_SIZE).toBeGreaterThan(0);
  });
});

describe("periodStart", () => {
  const now = new Date("2026-10-10T12:00:00.000Z");
  it("subtracts the period from now", () => {
    expect(periodStart("24h", now)).toBe("2026-10-09T12:00:00.000Z");
    expect(periodStart("7d", now)).toBe("2026-10-03T12:00:00.000Z");
  });
  it("has no start for all time", () => {
    expect(periodStart("all", now)).toBeNull();
  });
});

describe("display helpers", () => {
  it("makes action codes readable", () => {
    expect(describeAction("role.updated")).toBe("Role updated");
    expect(describeAction("api_key.created")).toBe("Api key created");
  });

  it("flags removals and access changes", () => {
    expect(actionTone("member.suspended")).toBe("destructive");
    expect(actionTone("contacts.exported")).toBe("warning");
    expect(actionTone("tag.created")).toBe("secondary");
  });

  it("previews diffs compactly and survives odd input", () => {
    expect(diffPreview(null)).toBe("");
    expect(diffPreview({})).toBe("");
    expect(diffPreview({ a: 1 })).toBe('{"a":1}');
    expect(diffPreview({ text: "x".repeat(300) }, 20)).toHaveLength(20);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(diffPreview(circular)).toBe("");
  });
});
