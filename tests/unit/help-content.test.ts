import { describe, expect, it } from "vitest";

import {
  CLIPS,
  clipForPath,
  clipsForRole,
  clipStatuses,
  readHelpSettings,
  writeHelpSettings,
} from "@/lib/help/clips";
import { FALLBACK_GUIDE, GUIDES, guideForPath } from "@/lib/help/guides";
import { isHelpKey, isTypingTarget, SHORTCUT_GROUPS } from "@/lib/help/shortcuts";
import { newestId, unseenCount, WHATS_NEW } from "@/lib/help/whats-new";
import { SYSTEM_ROLES } from "@/lib/auth/permissions";
import { NAV_ITEMS } from "@/components/shell/nav";

describe("training clips", () => {
  it("has unique ids and every system role has at least one clip", () => {
    const ids = CLIPS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const role of SYSTEM_ROLES)
      expect(clipsForRole(role.name).length, role.name).toBeGreaterThan(0);
  });

  it("offers everyone the welcome clip and a receptionist the front desk clips", () => {
    expect(clipsForRole("Agent").map((c) => c.id)).toContain("welcome");
    const reception = clipsForRole("receptionist").map((c) => c.id);
    for (const id of ["front-desk-board", "waitlist", "walk-ins-qr", "end-of-day"])
      expect(reception).toContain(id);
    expect(clipsForRole("Finance").map((c) => c.id)).not.toContain("front-desk-board");
  });

  it("opens the clip for the most specific matching page", () => {
    expect(clipForPath("/front-desk", "Receptionist")?.id).toBe("front-desk-board");
    expect(clipForPath("/front-desk/end-of-day", "Receptionist")?.id).toBe("end-of-day");
    expect(clipForPath("/front-desk/qr")?.id).toBe("walk-ins-qr");
    expect(clipForPath("/inbox")?.id).toBe("inbox");
    expect(clipForPath("/nowhere")).toBeNull();
  });

  it("shows 'coming soon' (no link) until a video is recorded, and only accepts https links", () => {
    const statuses = clipStatuses(CLIPS, { welcome: "https://videos.example.test/welcome" });
    expect(statuses.find((s) => s.clip.id === "welcome")?.url).toBe(
      "https://videos.example.test/welcome",
    );
    expect(statuses.find((s) => s.clip.id === "inbox")?.url).toBeNull();

    const read = readHelpSettings({
      help: {
        videos: {
          welcome: "https://v.example.test/a",
          inbox: "http://insecure.example.test/b",
          nope: "https://v.example.test/c",
          tasks: "javascript:alert(1)",
        },
      },
    });
    expect(read.videos).toEqual({ welcome: "https://v.example.test/a" });
    expect(readHelpSettings(null).videos).toEqual({});
    expect(writeHelpSettings({ keep: 1 }, read)).toEqual({ keep: 1, help: read });
  });
});

describe("guides", () => {
  it("gives every menu page a guide, and falls back for unknown pages", () => {
    for (const item of NAV_ITEMS) {
      if (
        item.href === "/portal" ||
        item.href === "/finance" ||
        item.href === "/dashboard" ||
        item.href === "/settings"
      )
        continue;
      expect(guideForPath(item.href).id, item.href).not.toBe("general");
    }
    expect(guideForPath("/finance/exceptions").id).toBe("finance-exceptions");
    expect(guideForPath("/finance/exceptions/123").id).toBe("finance-exceptions");
    expect(guideForPath("/finance").id).toBe("finance");
    expect(guideForPath("/settings/training").id).toBe("settings-training");
    expect(guideForPath("/settings").id).toBe("settings");
    expect(guideForPath("/somewhere/else")).toBe(FALLBACK_GUIDE);
  });

  it("keeps each guide to one page: a purpose, a few steps and a warning", () => {
    for (const g of GUIDES) {
      expect(g.purpose.length, g.id).toBeGreaterThan(10);
      expect(g.steps.length, g.id).toBeGreaterThanOrEqual(2);
      expect(g.steps.length, g.id).toBeLessThanOrEqual(6);
      expect(g.watchOut.length, g.id).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("what's new and shortcuts", () => {
  it("counts entries newer than the last one seen", () => {
    expect(newestId()).toBe(WHATS_NEW[0].id);
    expect(unseenCount(null)).toBe(WHATS_NEW.length);
    expect(unseenCount(WHATS_NEW[0].id)).toBe(0);
    expect(unseenCount(WHATS_NEW[2].id)).toBe(2);
    expect(unseenCount("unknown-id")).toBe(WHATS_NEW.length);
  });

  it("never fires a bare-key shortcut while someone is typing", () => {
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(
      isTypingTarget({ tagName: "DIV", getAttribute: (n) => (n === "role" ? "combobox" : null) }),
    ).toBe(true);
    expect(isTypingTarget({ tagName: "BODY" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("recognises ? but not Ctrl/Cmd/Alt combinations", () => {
    expect(isHelpKey({ key: "?" })).toBe(true);
    expect(isHelpKey({ key: "?", ctrlKey: true })).toBe(false);
    expect(isHelpKey({ key: "/" })).toBe(false);
    expect(SHORTCUT_GROUPS.flatMap((g) => g.items).some((i) => i.keys.includes("?"))).toBe(true);
  });
});

describe("what's new dates", () => {
  it("are newest first and never in the future", async () => {
    const { WHATS_NEW } = await import("@/lib/help/whats-new");
    const today = new Date().toISOString().slice(0, 10);
    const dates = WHATS_NEW.map((e) => e.date);
    expect(dates.filter((d) => d > today)).toEqual([]);
    expect([...dates].sort().reverse()).toEqual(dates);
  });
});
