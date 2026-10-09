import { describe, expect, it } from "vitest";

import { appendRows, moveCard } from "@/lib/enquiries/board";
import type { BoardColumn, EnquiryRow } from "@/lib/enquiries/types";

const row = (id: string, stage: string): EnquiryRow =>
  ({
    id,
    number: 1,
    stage_id: stage,
    stage_name: "Old",
    stage_color: "slate",
    stage_entered_at: "2026-01-01T00:00:00Z",
  }) as EnquiryRow;

const cols = (): BoardColumn[] => [
  { stage_id: "a", total: 3, rows: [row("1", "a"), row("2", "a")] },
  { stage_id: "b", total: 1, rows: [row("3", "b")] },
  { stage_id: "c", total: 0, rows: [] },
];

describe("moveCard", () => {
  it("moves a card to the top of the target and adjusts counts", () => {
    const now = new Date("2026-05-01T10:00:00Z");
    const next = moveCard(cols(), "1", { id: "b", name: "In progress", color: "blue" }, now);
    expect(next.map((c) => [c.stage_id, c.total, c.rows.map((r) => r.id)])).toEqual([
      ["a", 2, ["2"]],
      ["b", 2, ["1", "3"]],
      ["c", 0, []],
    ]);
    expect(next[1].rows[0]).toMatchObject({
      stage_id: "b",
      stage_name: "In progress",
      stage_color: "blue",
      stage_entered_at: now.toISOString(),
    });
  });
  it("does not mutate its input and ignores no-ops", () => {
    const before = cols();
    const copy = JSON.stringify(before);
    moveCard(before, "1", { id: "c", name: "x", color: "red" });
    expect(JSON.stringify(before)).toBe(copy);
    expect(moveCard(before, "1", { id: "a", name: "x", color: "red" })).toBe(before);
    expect(moveCard(before, "missing", { id: "b", name: "x", color: "red" })).toBe(before);
    expect(moveCard(before, "1", { id: "nope", name: "x", color: "red" })).toBe(before);
  });
  it("never lets a count go negative", () => {
    const c: BoardColumn[] = [
      { stage_id: "a", total: 0, rows: [row("1", "a")] },
      { stage_id: "b", total: 0, rows: [] },
    ];
    expect(moveCard(c, "1", { id: "b", name: "B", color: "red" })[0].total).toBe(0);
  });
});

describe("appendRows", () => {
  it("adds only new cards and updates the total", () => {
    const next = appendRows(cols(), "a", [row("2", "a"), row("9", "a")], 4);
    expect(next[0].rows.map((r) => r.id)).toEqual(["1", "2", "9"]);
    expect(next[0].total).toBe(4);
    expect(next[1]).toEqual(cols()[1]);
  });
});
