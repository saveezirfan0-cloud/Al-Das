import { describe, expect, it, vi } from "vitest";

import { clearListeners, emit, on } from "@/lib/events/emit";
import {
  DEFAULT_QUERY,
  matchesFolder,
  parseInboxQuery,
  queryToViewFilter,
  toSearchParams,
  viewFilterToQuery,
} from "@/lib/inbox/folders";
import { labelClass } from "@/lib/inbox/labels";
import { mentionQueryAtCaret, parseMentions } from "@/lib/inbox/mentions";
import { DEFAULT_INBOX_SETTINGS, readInboxSettings, writeInboxSettings } from "@/lib/inbox/settings";
import { extensionFor, mediaObjectPath } from "@/lib/jobs/handlers/media-fetch";
import { kindForSpec, sendSpecSchema } from "@/lib/inbox/send";

vi.mock("server-only", () => ({}));

describe("inbox query parsing", () => {
  it("parses params with safe defaults", () => {
    expect(parseInboxQuery({})).toEqual(DEFAULT_QUERY);
    const q = parseInboxQuery({ folder: "unread", sort: "oldest", status: "waiting", q: ["x"], team: "t1" });
    expect(q).toMatchObject({ folder: "unread", sort: "oldest", status: "waiting", q: "x", team: "t1" });
    expect(parseInboxQuery({ folder: "nope", status: "weird", sort: "sideways" })).toMatchObject({ folder: "open", status: "any", sort: "newest" });
    expect(parseInboxQuery({ q: "a".repeat(200) }).q.length).toBe(80);
  });
  it("round-trips through search params and saved views", () => {
    const q = parseInboxQuery({ folder: "mine", label: "l1", channel: "c1", q: "ali" });
    expect(toSearchParams(q, "conv1")).toBe("?folder=mine&q=ali&label=l1&channel=c1&c=conv1");
    expect(toSearchParams(DEFAULT_QUERY)).toBe("");
    expect(viewFilterToQuery(queryToViewFilter(q))).toEqual({ ...q, view: null });
    expect(viewFilterToQuery(null)).toEqual(DEFAULT_QUERY);
    expect(viewFilterToQuery({ folder: 5 })).toEqual(DEFAULT_QUERY);
  });
});

describe("matchesFolder", () => {
  const ctx = { userId: "me", teamIds: ["team1"], mentionConversationIds: new Set(["c-m"]) };
  const base = { id: "c1", status: "open", assignee_user_id: null, assignee_team_id: null, bot_active: false, unread_count: 0, channel_id: "ch" };
  it("applies each folder's rule", () => {
    expect(matchesFolder(base, "open", null, ctx)).toBe(true);
    expect(matchesFolder({ ...base, status: "closed" }, "open", null, ctx)).toBe(false);
    expect(matchesFolder(base, "unassigned", null, ctx)).toBe(true);
    expect(matchesFolder({ ...base, assignee_team_id: "team1" }, "unassigned", null, ctx)).toBe(false);
    expect(matchesFolder({ ...base, assignee_team_id: "team1" }, "mine", null, ctx)).toBe(true);
    expect(matchesFolder({ ...base, assignee_user_id: "me" }, "mine", null, ctx)).toBe(true);
    expect(matchesFolder({ ...base, assignee_user_id: "other" }, "mine", null, ctx)).toBe(false);
    expect(matchesFolder({ ...base, assignee_user_id: "me" }, "assigned_me", null, ctx)).toBe(true);
    expect(matchesFolder({ ...base, bot_active: true }, "bot", null, ctx)).toBe(true);
    expect(matchesFolder({ ...base, status: "waiting" }, "waiting", null, ctx)).toBe(true);
    expect(matchesFolder({ ...base, unread_count: 2 }, "unread", null, ctx)).toBe(true);
    expect(matchesFolder({ ...base, id: "c-m" }, "mentions", null, ctx)).toBe(true);
    expect(matchesFolder(base, "mentions", null, ctx)).toBe(false);
    expect(matchesFolder({ ...base, status: "closed" }, "closed", null, ctx)).toBe(true);
  });
  it("a team queue overrides the folder", () => {
    expect(matchesFolder({ ...base, assignee_team_id: "team2" }, "closed", "team2", ctx)).toBe(true);
    expect(matchesFolder({ ...base, assignee_team_id: "team2", status: "closed" }, "open", "team2", ctx)).toBe(false);
  });
});

describe("inbox settings", () => {
  it("reads defaults and tolerates bad values", () => {
    expect(readInboxSettings(null)).toEqual(DEFAULT_INBOX_SETTINGS);
    expect(readInboxSettings({ inbox: { auto_close_hours: 48, unread_alert_minutes: 30 } })).toMatchObject({ auto_close_hours: 48, unread_alert_minutes: 30, auto_assign: "round_robin" });
    expect(readInboxSettings({ inbox: { unread_alert_minutes: 5 } })).toEqual(DEFAULT_INBOX_SETTINGS); // below 15 → invalid → defaults
    expect(readInboxSettings("junk")).toEqual(DEFAULT_INBOX_SETTINGS);
  });
  it("writes without clobbering other sections", () => {
    const next = writeInboxSettings({ theme: "x" }, { ...DEFAULT_INBOX_SETTINGS, show_agent_name: true });
    expect(next.theme).toBe("x");
    expect((next.inbox as { show_agent_name: boolean }).show_agent_name).toBe(true);
  });
});

describe("mentions", () => {
  it("extracts user ids and strips the markup", () => {
    const r = parseMentions("Hi @[Dr Example](11111111-1111-4111-8111-111111111111) and @[Nurse X](22222222-2222-4222-8222-222222222222) — same @[Dr Example](11111111-1111-4111-8111-111111111111)");
    expect(r.text).toBe("Hi @Dr Example and @Nurse X — same @Dr Example");
    expect(r.userIds).toEqual(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]);
  });
  it("finds the query at the caret", () => {
    expect(mentionQueryAtCaret("hello @dr", 9)).toEqual({ query: "dr", start: 6 });
    expect(mentionQueryAtCaret("hello @dr ex", 12)).toBeNull();
    expect(mentionQueryAtCaret("mail@x", 6)).toBeNull();
    expect(mentionQueryAtCaret("@", 1)).toEqual({ query: "", start: 0 });
    expect(mentionQueryAtCaret("no at", 5)).toBeNull();
  });
});

describe("send specs", () => {
  it("validates and maps to message kinds", () => {
    expect(kindForSpec(sendSpecSchema.parse({ type: "text", body: "hi" }))).toBe("text");
    expect(kindForSpec(sendSpecSchema.parse({ type: "media", media_type: "document", media_path: "a/b.pdf", mime_type: "application/pdf" }))).toBe("document");
    expect(kindForSpec(sendSpecSchema.parse({ type: "template", template_id: "11111111-1111-4111-8111-111111111111" }))).toBe("template");
    expect(kindForSpec(sendSpecSchema.parse({ type: "reaction", wa_message_id: "w", emoji: "👍" }))).toBe("reaction");
    expect(kindForSpec(sendSpecSchema.parse({ type: "location", latitude: 1, longitude: 2 }))).toBe("location");
    expect(sendSpecSchema.safeParse({ type: "text", body: "" }).success).toBe(false);
    expect(sendSpecSchema.safeParse({ type: "media", media_type: "gif", media_path: "x", mime_type: "y" }).success).toBe(false);
  });
});

describe("media storage paths", () => {
  it("derives extensions and object paths", () => {
    expect(extensionFor("image/jpeg")).toBe("jpg");
    expect(extensionFor("audio/ogg; codecs=opus")).toBe("ogg");
    expect(extensionFor("application/pdf", "report.PDF")).toBe("pdf");
    expect(extensionFor("application/x-unknown")).toBe("bin");
    expect(extensionFor(null, "weird.name.with.toolongext")).toBe("bin");
    expect(mediaObjectPath("org", "conv", "msg", "jpg")).toBe("org/conv/msg.jpg");
  });
});

describe("labels", () => {
  it("falls back to gray", () => {
    expect(labelClass("blue")).toContain("blue");
    expect(labelClass("nope")).toBe(labelClass("gray"));
    expect(labelClass(null)).toBe(labelClass("gray"));
    expect(labelClass("gray")).not.toContain("blue");
  });
});

describe("domain events", () => {
  it("dispatches to listeners and survives a failing one", async () => {
    clearListeners();
    const seen: string[] = [];
    on("conversation.opened", () => {
      seen.push("specific");
    });
    on("*", () => {
      throw new Error("boom");
    });
    on("*", () => {
      seen.push("wild");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ev = await emit("org1", "conversation.opened", { conversation_id: "c1" });
    expect(ev.orgId).toBe("org1");
    expect(seen).toEqual(["specific", "wild"]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    clearListeners();
  });
});
