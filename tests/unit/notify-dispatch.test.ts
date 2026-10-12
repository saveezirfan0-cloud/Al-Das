import { describe, expect, it } from "vitest";

import {
  dispatchNotification,
  type DispatchDeps,
  type RecipientContext,
} from "@/lib/notify/dispatch";
import type { PrefRow } from "@/lib/notify/preferences";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STRANGER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function fake(
  people: Record<string, Partial<RecipientContext>>,
  now = new Date("2026-10-13T08:00:00Z"),
) {
  const sent = {
    inApp: [] as Array<Record<string, unknown>>,
    email: [] as Array<Record<string, unknown>>,
    push: [] as Array<Record<string, unknown>>,
  };
  const deps: DispatchDeps = {
    now: () => now,
    appUrl: "https://pulse.test/",
    async loadContext(_org, ids) {
      const recipients = new Map<string, RecipientContext>();
      for (const id of ids)
        if (people[id])
          recipients.set(id, {
            email: `${id.slice(0, 4)}@example.test`,
            timezone: null,
            prefs: [],
            ...people[id],
          });
      return { orgTimezone: "Asia/Dubai", recipients };
    },
    async insertInApp(rows) {
      sent.inApp.push(...rows);
    },
    async enqueueEmail(job) {
      sent.email.push(job);
    },
    async enqueuePush(job) {
      sent.push.push(job);
    },
  };
  return { deps, sent };
}

const input = {
  orgId: ORG,
  event: "inbox.message",
  type: "inbox.message",
  title: "New message",
  body: "A patient replied",
  ids: { conversation_id: CONV },
};

describe("dispatchNotification", () => {
  it("by default records in-app and queues a push, never an e-mail", async () => {
    const { deps, sent } = fake({ [ALICE]: {} });
    const res = await dispatchNotification(deps, { ...input, userIds: [ALICE] });
    expect(res).toEqual({ in_app: 1, email: 0, push: 1, recipients: 1 });
    expect(sent.inApp[0]).toMatchObject({
      org_id: ORG,
      user_id: ALICE,
      type: "inbox.message",
      title: "New message",
    });
    expect(sent.push[0]).toEqual({
      type: "push",
      org_id: ORG,
      user_id: ALICE,
      event: "inbox.message",
      ids: { conversation_id: CONV },
    });
    expect(sent.email).toEqual([]);
  });

  it("drops people who are not active members, duplicates and the person who acted", async () => {
    const { deps, sent } = fake({ [ALICE]: {}, [BOB]: {} });
    const res = await dispatchNotification(deps, {
      ...input,
      userIds: [ALICE, ALICE, BOB, STRANGER],
      exceptUserId: BOB,
    });
    expect(res.recipients).toBe(1);
    expect(sent.inApp.map((r) => r.user_id)).toEqual([ALICE]);
  });

  it("does nothing for an empty audience", async () => {
    const { deps } = fake({});
    expect(await dispatchNotification(deps, { ...input, userIds: [] })).toEqual({
      in_app: 0,
      email: 0,
      push: 0,
      recipients: 0,
    });
  });

  it("respects each person's preferences separately", async () => {
    const off: PrefRow[] = [{ event: "inbox.message", channel: "push", enabled: false }];
    const mail: PrefRow[] = [{ event: "inbox.message", channel: "email", enabled: true }];
    const { deps, sent } = fake({ [ALICE]: { prefs: off }, [BOB]: { prefs: mail } });
    await dispatchNotification(deps, { ...input, userIds: [ALICE, BOB] });
    expect(sent.push.map((j) => j.user_id)).toEqual([BOB]);
    expect(sent.email).toHaveLength(1);
  });

  it("sends e-mail with a generic sentence and a link, never the in-app copy", async () => {
    const mail: PrefRow[] = [{ event: "inbox.message", channel: "email", enabled: true }];
    const { deps, sent } = fake({ [ALICE]: { prefs: mail, email: "alice@example.test" } });
    await dispatchNotification(deps, {
      ...input,
      userIds: [ALICE],
      title: "Message from Sara Example",
      body: "I have chest pain, call +971501234567",
    });
    const job = sent.email[0] as { to: string; subject: string; text: string };
    expect(job.to).toBe("alice@example.test");
    expect(job.subject).toBe("New message");
    expect(job.text).toContain(`https://pulse.test/inbox?c=${CONV}`);
    for (const secret of ["Sara", "chest pain", "+971"])
      expect(JSON.stringify(sent.email)).not.toContain(secret);
    // In-app keeps whatever context the caller gave (the bell is private to the recipient).
    expect(sent.inApp[0]).toMatchObject({ title: "Message from Sara Example" });
  });

  it("holds push during the person's quiet hours but still records in-app", async () => {
    const quiet: PrefRow[] = [
      {
        event: "*",
        channel: "push",
        enabled: true,
        quiet_start: "22:00:00",
        quiet_end: "07:00:00",
      },
    ];
    const night = new Date("2026-10-13T19:00:00Z"); // 23:00 in Dubai
    const { deps, sent } = fake({ [ALICE]: { prefs: quiet } }, night);
    const res = await dispatchNotification(deps, { ...input, userIds: [ALICE] });
    expect(res).toMatchObject({ in_app: 1, push: 0 });
    expect(sent.push).toEqual([]);
  });

  it("uses the person's own timezone for quiet hours when they set one", async () => {
    const quiet: PrefRow[] = [
      {
        event: "*",
        channel: "push",
        enabled: true,
        quiet_start: "22:00:00",
        quiet_end: "07:00:00",
      },
    ];
    const t = new Date("2026-10-13T19:00:00Z"); // 23:00 Dubai, 12:00 in Los Angeles
    const { deps } = fake({ [ALICE]: { prefs: quiet, timezone: "America/Los_Angeles" } }, t);
    expect((await dispatchNotification(deps, { ...input, userIds: [ALICE] })).push).toBe(1);
  });

  it("can be limited to some channels (used where another path already sends the in-app and e-mail)", async () => {
    const { deps, sent } = fake({ [ALICE]: {} });
    const res = await dispatchNotification(deps, {
      ...input,
      event: "sla.breach",
      type: "enquiry.sla_breached",
      userIds: [ALICE],
      only: ["push"],
    });
    expect(res).toMatchObject({ in_app: 0, push: 1 });
    expect(sent.inApp).toEqual([]);
  });

  it("delivers nothing for an event that is not in the catalogue", async () => {
    const { deps, sent } = fake({ [ALICE]: {} });
    const res = await dispatchNotification(deps, { ...input, event: "made.up", userIds: [ALICE] });
    expect(res).toMatchObject({ in_app: 0, email: 0, push: 0 });
    expect(sent.push).toEqual([]);
  });
});
