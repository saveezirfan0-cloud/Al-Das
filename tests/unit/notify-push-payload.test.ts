import { describe, expect, it } from "vitest";

import { buildPushPayload, genericEmail, pushUrl } from "@/lib/notify/push-payload";
import { notificationHref } from "@/lib/notify/links";

const UUID = "3f2b8d6e-1c4a-4e7b-9a55-0c1d2e3f4a5b";

describe("push payloads carry ids and generic text only", () => {
  it("builds a payload for each pushable event", () => {
    for (const event of [
      "inbox.message",
      "inbox.assigned",
      "inbox.mention",
      "sla.breach",
      "reminder.failed",
      "task.due",
      "escalation",
      "test",
    ]) {
      const p = buildPushPayload(event, { conversation_id: UUID });
      expect(p, event).not.toBeNull();
      expect(p!.v).toBe(1);
      expect(p!.url.startsWith("/")).toBe(true);
    }
  });

  it("has no way to smuggle a name, a phone number or message text into the payload", () => {
    const phi = ["Sara Example", "+971501234567", "I have chest pain", "sara@example.test"];
    // The only inputs are ids; anything that is not a UUID is dropped, so hostile values never reach the output.
    const p = buildPushPayload("inbox.message", {
      conversation_id: "Sara Example",
      task_id: "+971501234567",
      enquiry_id: "I have chest pain",
      appointment_id: "sara@example.test",
    })!;
    const json = JSON.stringify(p);
    for (const secret of phi) expect(json).not.toContain(secret);
    expect(p.ids).toEqual({
      conversation_id: null,
      task_id: null,
      enquiry_id: null,
      appointment_id: null,
    });
    expect(p.url).toBe("/inbox");
  });

  it("keeps the title and body generic: no digits, no @, short", () => {
    for (const event of [
      "inbox.message",
      "inbox.assigned",
      "inbox.mention",
      "sla.breach",
      "reminder.failed",
      "task.due",
      "escalation",
    ]) {
      const p = buildPushPayload(event, {})!;
      expect(`${p.title} ${p.body}`, event).not.toMatch(/[0-9@+]/);
      expect(p.title.length).toBeLessThan(40);
      expect(p.body.length).toBeLessThan(100);
    }
  });

  it("opens the right page, and only ever a same-origin path", () => {
    expect(pushUrl("inbox.message", { conversation_id: UUID })).toBe(`/inbox?c=${UUID}`);
    expect(pushUrl("sla.breach", { enquiry_id: UUID })).toBe(`/enquiries?enquiry=${UUID}`);
    expect(pushUrl("task.due", { task_id: UUID })).toBe(`/tasks?task=${UUID}`);
    expect(pushUrl("task.due", {})).toBe("/tasks");
    expect(pushUrl("reminder.failed", { appointment_id: UUID })).toBe(
      `/appointments?appointment=${UUID}`,
    );
    expect(pushUrl("something.else", {})).toBe("/notifications");
    expect(pushUrl("inbox.message", { conversation_id: "//evil.example/x" })).toBe("/inbox");
    expect(buildPushPayload("inbox.message", { conversation_id: UUID.toUpperCase() })!.url).toBe(
      `/inbox?c=${UUID}`,
    );
  });

  it("collapses repeats about the same thing with a tag, and refuses unknown events", () => {
    expect(buildPushPayload("inbox.message", { conversation_id: UUID })!.tag).toBe(
      `inbox.message:${UUID}`,
    );
    expect(buildPushPayload("not.an.event", {})).toBeNull();
  });

  it("gives e-mail the same generic sentence", () => {
    const m = genericEmail("inbox.message")!;
    expect(m.subject).toBe("New message");
    expect(genericEmail("digest.daily")).toBeNull();
  });
});

describe("notification links in the centre", () => {
  it("links by validated ids", () => {
    expect(notificationHref("mention", { conversation_id: UUID })).toBe(`/inbox?c=${UUID}`);
    // A task about an enquiry opens the task, the same place its push opens.
    expect(notificationHref("task.due", { task_id: UUID, enquiry_id: UUID })).toBe(
      `/tasks?task=${UUID}`,
    );
    expect(notificationHref("reminder.failed", { appointment_id: UUID })).toBe(
      `/appointments?appointment=${UUID}`,
    );
    expect(notificationHref("finance.close_due", { count: 2 })).toBe("/finance/close/timetable");
    expect(notificationHref("finance.followup_due", { count: 3 })).toBe("/finance/followup");
    expect(notificationHref("enquiry.sla_breached", { enquiry_id: UUID })).toBe(
      `/enquiries?enquiry=${UUID}`,
    );
    expect(notificationHref("task.due", {})).toBe("/tasks");
    expect(notificationHref("appointment.reminder_failed", { appointment_id: UUID })).toBe(
      `/appointments?appointment=${UUID}`,
    );
    expect(notificationHref("system", {})).toBeNull();
    expect(notificationHref("mention", { conversation_id: "../../etc" })).toBeNull();
    expect(notificationHref("mention", null)).toBeNull();
  });
});

describe("insurance card expiry notifications (Phase 16)", () => {
  it("is a catalogued event, offered only to people who manage documents", async () => {
    const { getEvent, eventsFor, categoryForType, typeFilterForCategory } =
      await import("@/lib/notify/events");
    const e = getEvent("document.expiring")!;
    expect(e.permission).toBe("documents.manage");
    expect(e.defaults).toEqual({ in_app: true, email: false, push: true });
    expect(eventsFor(() => false).some((x) => x.key === "document.expiring")).toBe(false);
    expect(
      eventsFor((p) => p === "documents.manage").some((x) => x.key === "document.expiring"),
    ).toBe(true);
    expect(categoryForType("document.expiring")).toBe("work");
    expect(typeFilterForCategory("work").prefixes).toContain("document.");
  });

  it("pushes a fixed sentence with no name, and opens Tasks when a task exists", () => {
    const p = buildPushPayload("document.expiring", { task_id: UUID })!;
    expect(p.url).toBe(`/tasks?task=${UUID}`);
    expect(`${p.title} ${p.body}`).not.toMatch(/[0-9@+]/);
    expect(JSON.stringify(p)).not.toMatch(/Sara|\+971|chest/);
    expect(pushUrl("document.expiring", {})).toBe("/notifications");
    expect(genericEmail("document.expiring")?.subject).toBe("Insurance card expiring");
  });

  it("opens the patient from the in-app notification, only for document events and valid ids", () => {
    expect(notificationHref("document.expiring", { contact_id: UUID, document_id: UUID })).toBe(
      `/contacts?contact=${UUID}`,
    );
    expect(notificationHref("document.expiring", { contact_id: "Sara Example" })).toBeNull();
    expect(notificationHref("document.expiring", { count: 3 })).toBeNull();
    expect(notificationHref("mention", { contact_id: UUID })).toBeNull();
  });
});

describe("management alerts (M1)", () => {
  const EVENTS = {
    "finance.report_late": ["finance.revenue.import", "/finance/upload"],
    "finance.revenue_behind": ["finance.flash.view", "/finance/flash"],
    "finance.band_below": ["finance.revenue.view", "/finance/doctor-performance"],
  } as const;

  it("are catalogued, gated by their finance permission, with a fixed sentence and no figures", async () => {
    const { getEvent, eventsFor } = await import("@/lib/notify/events");
    for (const [event, [permission, url]] of Object.entries(EVENTS)) {
      expect(getEvent(event)?.permission, event).toBe(permission);
      expect(eventsFor(() => false).some((e) => e.key === event)).toBe(false);
      const p = buildPushPayload(event, { task_id: UUID })!;
      expect(p.url).toBe(url);
      expect(`${p.title} ${p.body}`, event).not.toMatch(/[0-9@+]/);
      expect(genericEmail(event)?.sentence).toBe(p.body);
    }
  });

  it("open the page in the centre; the band alert opens its month, validated", () => {
    expect(notificationHref("finance.report_late", { count: 1 })).toBe("/finance/upload");
    expect(notificationHref("finance.revenue_behind", { month: "2026-10" })).toBe("/finance/flash");
    expect(notificationHref("finance.band_below", { month: "2026-09" })).toBe(
      "/finance/doctor-performance?month=2026-09",
    );
    expect(notificationHref("finance.band_below", { month: "2026-13" })).toBe(
      "/finance/doctor-performance",
    );
    expect(notificationHref("finance.band_below", { month: "//evil.example" })).toBe(
      "/finance/doctor-performance",
    );
  });
});
