/**
 * D5 inbox paging: cursor format, the keyset filters and how pages merge. Synthetic ids only.
 */
import { describe, expect, it } from "vitest";

import {
  conversationAfterFilter,
  decodeCursor,
  droppedFromLive,
  encodeCursor,
  isCursorTimestamp,
  mergeConversationPages,
  mergeMessagePages,
  messagesBeforeFilter,
  takePage,
} from "@/lib/inbox/paging";

const ID_A = "00000000-0000-4000-8000-00000000000a";
const ID_B = "00000000-0000-4000-8000-00000000000b";
const ID_C = "00000000-0000-4000-8000-00000000000c";
const ID_D = "00000000-0000-4000-8000-00000000000d";
const TS = "2026-10-14T09:15:02.123456+00:00";

describe("cursor encode / decode", () => {
  it("round-trips a timestamp and id, keeping microseconds", () => {
    const raw = encodeCursor({ at: TS, id: ID_A });
    expect(decodeCursor(raw)).toEqual({ at: TS, id: ID_A });
  });

  it("round-trips a conversation with no messages (null timestamp)", () => {
    expect(decodeCursor(encodeCursor({ at: null, id: ID_B }))).toEqual({ at: null, id: ID_B });
  });

  it("accepts the timestamp shapes PostgREST returns", () => {
    expect(isCursorTimestamp("2026-10-14T09:15:02+00:00")).toBe(true);
    expect(isCursorTimestamp("2026-10-14T09:15:02.1Z")).toBe(true);
    expect(isCursorTimestamp("2026-10-14 09:15:02.123456+04")).toBe(true);
  });

  it("refuses anything it did not write (never throws)", () => {
    for (const bad of [
      undefined,
      null,
      42,
      "",
      "|",
      `${TS}`,
      `${TS}|not-a-uuid`,
      `yesterday|${ID_A}`,
      `2026-13-45T99:99:99Z|${ID_A}`,
      `${TS},id.gt.0|${ID_A}`,
      `"${TS}"|${ID_A}`,
      `${TS})|${ID_A}`,
      `${TS}|${ID_A}|${ID_B}`,
      "x".repeat(200),
    ]) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });
});

describe("keyset filters", () => {
  it("newest first: older timestamp, or same timestamp and smaller id, or no messages", () => {
    expect(conversationAfterFilter({ at: TS, id: ID_A }, "newest")).toBe(
      `last_message_at.lt."${TS}",and(last_message_at.eq."${TS}",id.lt.${ID_A}),last_message_at.is.null`,
    );
  });

  it("newest first past the nulls: only nulls with a smaller id", () => {
    expect(conversationAfterFilter({ at: null, id: ID_A }, "newest")).toBe(
      `and(last_message_at.is.null,id.lt.${ID_A})`,
    );
  });

  it("oldest first: nulls come first, then ascending", () => {
    expect(conversationAfterFilter({ at: null, id: ID_A }, "oldest")).toBe(
      `and(last_message_at.is.null,id.gt.${ID_A}),last_message_at.not.is.null`,
    );
    expect(conversationAfterFilter({ at: TS, id: ID_A }, "oldest")).toBe(
      `last_message_at.gt."${TS}",and(last_message_at.eq."${TS}",id.gt.${ID_A})`,
    );
  });

  it("messages before a cursor", () => {
    expect(messagesBeforeFilter({ at: TS, id: ID_A })).toBe(
      `at.lt."${TS}",and(at.eq."${TS}",id.lt.${ID_A})`,
    );
    expect(() => messagesBeforeFilter({ at: null, id: ID_A })).toThrow();
  });
});

describe("takePage", () => {
  const cursorOf = (r: { id: string; at: string }) => ({ at: r.at, id: r.id });
  const rows = [
    { id: ID_A, at: "2026-10-14T10:00:00+00:00" },
    { id: ID_B, at: "2026-10-14T09:00:00+00:00" },
    { id: ID_C, at: "2026-10-14T08:00:00+00:00" },
  ];

  it("no cursor when the fetch (limit + 1) came back short", () => {
    expect(takePage(rows, 3, cursorOf)).toEqual({ rows, nextCursor: null });
  });

  it("trims the extra row and points the cursor at the last kept row", () => {
    const page = takePage(rows, 2, cursorOf);
    expect(page.rows.map((r) => r.id)).toEqual([ID_A, ID_B]);
    expect(decodeCursor(page.nextCursor)).toEqual({ at: rows[1].at, id: ID_B });
  });
});

describe("mergeConversationPages", () => {
  it("appends older pages after the live first page, one row per conversation", () => {
    const first = [
      { id: ID_A, v: "fresh" },
      { id: ID_B, v: "fresh" },
    ];
    const older = [
      { id: ID_B, v: "stale" },
      { id: ID_C, v: "old" },
      { id: ID_C, v: "dup" },
    ];
    expect(mergeConversationPages(first, older)).toEqual([
      { id: ID_A, v: "fresh" },
      { id: ID_B, v: "fresh" },
      { id: ID_C, v: "old" },
    ]);
  });

  it("returns the first page unchanged when nothing older is loaded", () => {
    const first = [{ id: ID_A }];
    expect(mergeConversationPages(first, [])).toEqual(first);
  });
});

describe("mergeMessagePages", () => {
  const m = (id: string, at: string, status = "sent") => ({ id, at, status });

  it("prepends earlier pages, oldest first, live copy wins", () => {
    const earlier = [m(ID_A, "2026-10-14T08:00:00+00:00"), m(ID_B, "2026-10-14T09:00:00+00:00")];
    const live = [
      m(ID_B, "2026-10-14T09:00:00+00:00", "read"),
      m(ID_C, "2026-10-14T10:00:00+00:00"),
    ];
    expect(mergeMessagePages(earlier, live)).toEqual([
      m(ID_A, "2026-10-14T08:00:00+00:00"),
      m(ID_B, "2026-10-14T09:00:00+00:00", "read"),
      m(ID_C, "2026-10-14T10:00:00+00:00"),
    ]);
  });

  it("orders same-time messages by id and compares instants, not strings", () => {
    const merged = mergeMessagePages(
      [m(ID_B, "2026-10-14T09:00:00+00:00"), m(ID_A, "2026-10-14T09:00:00+00:00")],
      [m(ID_C, "2026-10-14T12:30:00+04:00")], // 08:30 UTC: earliest
    );
    expect(merged.map((x) => x.id)).toEqual([ID_C, ID_A, ID_B]);
  });
});

describe("droppedFromLive", () => {
  const m = (id: string, at: string) => ({ id, at });
  const a = m(ID_A, "2026-10-14T08:00:00+00:00");
  const b = m(ID_B, "2026-10-14T09:00:00+00:00");
  const c = m(ID_C, "2026-10-14T10:00:00+00:00");
  const d = m(ID_D, "2026-10-14T11:00:00+00:00");

  it("keeps the messages pushed out of the live page by newer ones", () => {
    expect(droppedFromLive([a, b, c], [b, c, d])).toEqual([a]);
  });

  it("keeps nothing when the live page did not move", () => {
    expect(droppedFromLive([a, b], [a, b])).toEqual([]);
    expect(droppedFromLive([], [a])).toEqual([]);
  });

  it("does not keep a message that vanished from inside the live page", () => {
    expect(droppedFromLive([a, b, c], [a, c])).toEqual([]);
  });
});
