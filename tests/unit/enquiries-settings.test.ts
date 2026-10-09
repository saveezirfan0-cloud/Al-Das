import { describe, expect, it } from "vitest";

import { planRecipients } from "@/lib/enquiries/notify-plan";
import {
  DEFAULT_ENQUIRY_SETTINGS,
  enquirySettingsSchema,
  readEnquirySettings,
  writeEnquirySettings,
  type NotificationRule,
} from "@/lib/enquiries/settings";

const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const U3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const T1 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

describe("enquiry settings", () => {
  it("defaults: no SLA, assigned + SLA breach notify the assignee in-app", () => {
    expect(DEFAULT_ENQUIRY_SETTINGS.sla_default_minutes).toBeNull();
    const events = DEFAULT_ENQUIRY_SETTINGS.notification_rules.map((r) => r.event).sort();
    expect(events).toEqual(["assigned", "sla_breached"]);
    expect(DEFAULT_ENQUIRY_SETTINGS.sources).toContain("WhatsApp");
  });

  it("reads tolerant of missing or invalid stored values", () => {
    expect(readEnquirySettings(null)).toEqual(DEFAULT_ENQUIRY_SETTINGS);
    expect(readEnquirySettings({ enquiries: { sla_default_minutes: 9999 } })).toEqual(
      DEFAULT_ENQUIRY_SETTINGS,
    );
    expect(readEnquirySettings({ enquiries: { sla_default_minutes: 30 } }).sla_default_minutes).toBe(30);
  });

  it("writes only the enquiries section and keeps the rest of org.settings", () => {
    const next = enquirySettingsSchema.parse({ sla_default_minutes: 15 });
    const out = writeEnquirySettings({ inbox: { show_agent_name: true } }, next);
    expect(out.inbox).toEqual({ show_agent_name: true });
    expect((out.enquiries as { sla_default_minutes: number }).sla_default_minutes).toBe(15);
    expect(writeEnquirySettings(null, next).enquiries).toBeDefined();
  });
});

describe("planRecipients", () => {
  const rule = (over: Partial<NotificationRule>): NotificationRule => ({
    id: "r",
    enabled: true,
    event: "assigned",
    assignee: true,
    user_ids: [],
    team_id: null,
    in_app: true,
    email: false,
    ...over,
  });
  const teamMembers = (t: string) => (t === T1 ? [U2, U3] : []);

  it("notifies the assignee but never the actor", () => {
    const rules = [rule({})];
    expect(planRecipients({ event: "assigned", rules, assigneeId: U1, actorId: null, teamMembers })).toEqual([
      { userId: U1, inApp: true, email: false },
    ]);
    expect(planRecipients({ event: "assigned", rules, assigneeId: U1, actorId: U1, teamMembers })).toEqual([]);
  });

  it("adds listed users and team members, merging channels per person", () => {
    const rules = [
      rule({ user_ids: [U2], in_app: true, email: false }),
      rule({ assignee: false, team_id: T1, in_app: false, email: true }),
    ];
    const res = planRecipients({ event: "assigned", rules, assigneeId: U1, actorId: null, teamMembers });
    expect(res).toContainEqual({ userId: U1, inApp: true, email: false });
    expect(res).toContainEqual({ userId: U2, inApp: true, email: true });
    expect(res).toContainEqual({ userId: U3, inApp: false, email: true });
    expect(res).toHaveLength(3);
  });

  it("ignores disabled rules, other events and unassigned enquiries", () => {
    expect(
      planRecipients({ event: "assigned", rules: [rule({ enabled: false })], assigneeId: U1, actorId: null, teamMembers }),
    ).toEqual([]);
    expect(
      planRecipients({ event: "created", rules: [rule({})], assigneeId: U1, actorId: null, teamMembers }),
    ).toEqual([]);
    expect(planRecipients({ event: "assigned", rules: [rule({})], assigneeId: null, actorId: null, teamMembers })).toEqual([]);
  });

  it("drops recipients with no channel enabled", () => {
    expect(
      planRecipients({ event: "assigned", rules: [rule({ in_app: false, email: false })], assigneeId: U1, actorId: null, teamMembers }),
    ).toEqual([]);
  });
});
