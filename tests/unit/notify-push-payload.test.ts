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
    expect(pushUrl("task.due", { task_id: UUID })).toBe("/tasks");
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
    expect(notificationHref("enquiry.sla_breached", { enquiry_id: UUID })).toBe(
      `/enquiries?enquiry=${UUID}`,
    );
    expect(notificationHref("task.due", {})).toBe("/tasks");
    expect(notificationHref("appointment.reminder_failed", { appointment_id: UUID })).toBe(
      "/appointments",
    );
    expect(notificationHref("system", {})).toBeNull();
    expect(notificationHref("mention", { conversation_id: "../../etc" })).toBeNull();
    expect(notificationHref("mention", null)).toBeNull();
  });
});
