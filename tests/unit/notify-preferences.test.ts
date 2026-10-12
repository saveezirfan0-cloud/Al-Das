import { describe, expect, it } from "vitest";

import {
  CHANNEL_LABELS,
  EVENT_KEYS,
  NOTIFICATION_EVENTS,
  categoryForType,
  eventsFor,
  getEvent,
  isEventKey,
  typeFilterForCategory,
} from "@/lib/notify/events";
import {
  effectiveSetting,
  inQuietHours,
  resolveDelivery,
  timeToMinutes,
  type PrefRow,
} from "@/lib/notify/preferences";
import { buildPreferenceRows, preferencesInput } from "@/lib/notify/preferences-input";

const TZ = "Asia/Dubai"; // UTC+4, no DST
// 22:30 in Dubai = 18:30 UTC; 03:00 in Dubai = 23:00 UTC the day before; 12:00 in Dubai = 08:00 UTC.
const at = (hhmmUtc: string) => new Date(`2026-10-13T${hhmmUtc}:00Z`);

describe("the event catalogue", () => {
  it("covers the six events in the spec plus escalation and the digests, with unique keys", () => {
    expect(EVENT_KEYS).toEqual(
      expect.arrayContaining([
        "inbox.message",
        "inbox.assigned",
        "inbox.mention",
        "sla.breach",
        "reminder.failed",
        "task.due",
      ]),
    );
    expect(new Set(EVENT_KEYS).size).toBe(EVENT_KEYS.length);
    expect(isEventKey("task.due")).toBe(true);
    expect(isEventKey("made.up")).toBe(false);
  });

  it("only offers e-mail for digests, and hides permission-gated events without the permission", () => {
    expect(getEvent("digest.daily")!.channels).toEqual(["email"]);
    const agent = eventsFor((p) => p === "inbox.send").map((e) => e.key);
    expect(agent).not.toContain("digest.daily");
    expect(agent).not.toContain("reminder.failed");
    const manager = eventsFor(() => true).map((e) => e.key);
    expect(manager).toContain("digest.weekly");
    expect(manager).toContain("reminder.failed");
  });

  it("defaults: in-app on for everything that is not a digest, e-mail never, digests off", () => {
    for (const e of NOTIFICATION_EVENTS) {
      expect(e.defaults.email, e.key).toBe(false);
      if (e.key.startsWith("digest.")) expect(e.defaults.in_app).toBe(false);
      else expect(e.defaults.in_app, e.key).toBe(true);
    }
  });

  it("has a label for every channel", () => {
    expect(Object.keys(CHANNEL_LABELS).sort()).toEqual(["email", "in_app", "push"]);
  });

  it("sorts stored notification types into centre categories, and the filters agree", () => {
    expect(categoryForType("mention")).toBe("inbox");
    expect(categoryForType("inbox.assigned")).toBe("inbox");
    expect(categoryForType("escalation")).toBe("escalation");
    expect(categoryForType("task.due")).toBe("work");
    expect(categoryForType("enquiry.sla_breached")).toBe("work");
    expect(categoryForType("appointment.reminder_failed")).toBe("work");
    expect(categoryForType("security.alert")).toBe("security");
    expect(categoryForType("finance.alert")).toBe("system");
    expect(typeFilterForCategory("inbox")).toEqual({ exact: ["mention"], prefixes: ["inbox."] });
    expect(typeFilterForCategory("system")).toEqual({ exact: [], prefixes: [] });
  });
});

describe("quiet hours", () => {
  it("parses Postgres time strings", () => {
    expect(timeToMinutes("22:30:00")).toBe(22 * 60 + 30);
    expect(timeToMinutes("07:05")).toBe(7 * 60 + 5);
    expect(timeToMinutes("25:00")).toBeNull();
    expect(timeToMinutes("nope")).toBeNull();
    expect(timeToMinutes(null)).toBeNull();
  });

  it("handles a window that crosses midnight, in the person's timezone", () => {
    expect(inQuietHours(at("18:30"), TZ, "22:00", "07:00")).toBe(true); // 22:30 local
    expect(inQuietHours(at("23:00"), TZ, "22:00", "07:00")).toBe(true); // 03:00 local
    expect(inQuietHours(at("08:00"), TZ, "22:00", "07:00")).toBe(false); // 12:00 local
    expect(inQuietHours(at("03:00"), TZ, "22:00", "07:00")).toBe(false); // 07:00 local: end is exclusive
  });

  it("handles a same-day window and treats start = end or bad data as never quiet", () => {
    expect(inQuietHours(at("08:00"), TZ, "12:00", "13:00")).toBe(true);
    expect(inQuietHours(at("09:30"), TZ, "12:00", "13:00")).toBe(false);
    expect(inQuietHours(at("08:00"), TZ, "12:00", "12:00")).toBe(false);
    expect(inQuietHours(at("08:00"), TZ, null, "13:00")).toBe(false);
    expect(inQuietHours(at("08:00"), "Not/AZone", "00:00", "23:59")).toBe(false);
  });
});

describe("resolveDelivery", () => {
  const now = at("08:00"); // midday in Dubai

  it("uses the catalogue defaults when the person has chosen nothing", () => {
    const d = resolveDelivery({ event: "inbox.message", prefs: [], now, timezone: TZ });
    expect(d.deliver).toEqual({ in_app: true, email: false, push: true });
    expect(d.held.email).toBe("event_off");
  });

  it("honours a per-event switch, either way", () => {
    const prefs: PrefRow[] = [
      { event: "inbox.message", channel: "push", enabled: false },
      { event: "inbox.message", channel: "email", enabled: true },
    ];
    expect(resolveDelivery({ event: "inbox.message", prefs, now, timezone: TZ }).deliver).toEqual({
      in_app: true,
      email: true,
      push: false,
    });
  });

  it("lets a channel master switch override every event", () => {
    const prefs: PrefRow[] = [
      { event: "*", channel: "push", enabled: false },
      { event: "task.due", channel: "push", enabled: true },
    ];
    const d = resolveDelivery({ event: "task.due", prefs, now, timezone: TZ });
    expect(d.deliver.push).toBe(false);
    expect(d.held.push).toBe("master_off");
    expect(d.deliver.in_app).toBe(true);
  });

  it("holds push and e-mail during quiet hours but never the in-app record", () => {
    const prefs: PrefRow[] = [
      {
        event: "*",
        channel: "push",
        enabled: true,
        quiet_start: "22:00:00",
        quiet_end: "07:00:00",
      },
      {
        event: "*",
        channel: "email",
        enabled: true,
        quiet_start: "22:00:00",
        quiet_end: "07:00:00",
      },
      { event: "inbox.message", channel: "email", enabled: true },
    ];
    const night = resolveDelivery({
      event: "inbox.message",
      prefs,
      now: at("18:30"),
      timezone: TZ,
    });
    expect(night.deliver).toEqual({ in_app: true, email: false, push: false });
    expect(night.held.push).toBe("quiet_hours");
    const day = resolveDelivery({ event: "inbox.message", prefs, now, timezone: TZ });
    expect(day.deliver).toEqual({ in_app: true, email: true, push: true });
  });

  it("lets an escalation through quiet hours", () => {
    const prefs: PrefRow[] = [
      {
        event: "*",
        channel: "push",
        enabled: true,
        quiet_start: "22:00:00",
        quiet_end: "07:00:00",
      },
    ];
    expect(
      resolveDelivery({ event: "escalation", prefs, now: at("18:30"), timezone: TZ }).deliver.push,
    ).toBe(true);
    expect(
      resolveDelivery({ event: "task.due", prefs, now: at("18:30"), timezone: TZ }).deliver.push,
    ).toBe(false);
  });

  it("does not offer push or in-app for a digest, and fails closed on an unknown event", () => {
    const prefs: PrefRow[] = [{ event: "digest.daily", channel: "email", enabled: true }];
    const d = resolveDelivery({ event: "digest.daily", prefs, now, timezone: TZ });
    expect(d.deliver).toEqual({ in_app: false, email: true, push: false });
    expect(resolveDelivery({ event: "made.up", prefs: [], now, timezone: TZ }).deliver).toEqual({
      in_app: false,
      email: false,
      push: false,
    });
  });

  it("reports the setting the form should show", () => {
    expect(effectiveSetting("task.due", "push", [])).toBe(true);
    expect(effectiveSetting("task.due", "email", [])).toBe(false);
    expect(
      effectiveSetting("task.due", "push", [
        { event: "task.due", channel: "push", enabled: false },
      ]),
    ).toBe(false);
  });
});

describe("saving preferences", () => {
  const base = { orgId: "o", userId: "u", canDo: () => false };

  it("turns the form into rows, with the channel master rows carrying quiet hours", () => {
    const input = preferencesInput.parse({
      toggles: [{ event: "task.due", channel: "push", enabled: false }],
      channels: [
        { channel: "push", enabled: true, quiet_start: "22:00", quiet_end: "07:00" },
        { channel: "in_app", enabled: true },
      ],
    });
    const { rows, error } = buildPreferenceRows({ ...base, input });
    expect(error).toBeNull();
    expect(rows).toContainEqual(
      expect.objectContaining({
        event: "task.due",
        channel: "push",
        enabled: false,
        quiet_start: null,
      }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        event: "*",
        channel: "push",
        quiet_start: "22:00",
        quiet_end: "07:00",
      }),
    );
    expect(rows.find((r) => r.event === "*" && r.channel === "in_app")!.quiet_start).toBeNull();
  });

  it("drops events that are unknown, channels an event does not use, and gated events without the permission", () => {
    const input = preferencesInput.parse({
      toggles: [
        { event: "made.up", channel: "push", enabled: true },
        { event: "digest.daily", channel: "push", enabled: true },
        { event: "digest.daily", channel: "email", enabled: true },
      ],
      channels: [],
    });
    expect(buildPreferenceRows({ ...base, input }).rows).toEqual([]);
    const allowed = buildPreferenceRows({
      ...base,
      canDo: (p) => p === "reports.view",
      input,
    }).rows;
    expect(allowed).toHaveLength(1);
    expect(allowed[0]).toMatchObject({ event: "digest.daily", channel: "email" });
  });

  it("rejects half a quiet window, an empty one, and malformed times", () => {
    const half = preferencesInput.parse({
      toggles: [],
      channels: [{ channel: "email", enabled: true, quiet_start: "22:00" }],
    });
    expect(buildPreferenceRows({ ...base, input: half }).error).toMatch(/both/);
    const same = preferencesInput.parse({
      toggles: [],
      channels: [{ channel: "email", enabled: true, quiet_start: "08:00", quiet_end: "08:00" }],
    });
    expect(buildPreferenceRows({ ...base, input: same }).error).toMatch(/same time/);
    expect(
      preferencesInput.safeParse({
        toggles: [],
        channels: [{ channel: "email", enabled: true, quiet_start: "25:00", quiet_end: "07:00" }],
      }).success,
    ).toBe(false);
  });
});
