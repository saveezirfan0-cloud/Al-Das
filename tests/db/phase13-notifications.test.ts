/**
 * Phase 13: notification preferences, push subscriptions, digest log, snooze, escalation columns and the
 * dashboard_overview function, against a real Postgres (RLS as `authenticated`), plus the services that sit on
 * them through PostgREST (dispatch, push store, escalation ladder, digests, notification-centre queries).
 * Runs only with TEST_DATABASE_URL (and TEST_POSTGREST_URL + TEST_SERVICE_JWT for the second half). Fake data only.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  decryptSubscription,
  dbPushStore,
  removeSubscription,
  saveSubscription,
} from "@/lib/push/store-db";
import { endpointHash } from "@/lib/push/endpoint";
import { auditApiRead } from "@/lib/public-api/audit-read";
import { processInbound } from "@/lib/inbox/inbound";
import { parseWebhookBody } from "@/lib/whatsapp/parse";
import { handleEscalation, scheduleFirstEscalation } from "@/lib/notify/escalation-job";
import { applyCentreFilters } from "@/lib/notify/centre-query";
import { memberIdsWithPermission, notify } from "@/lib/notify/dispatch-db";
import { runDigests } from "@/lib/jobs/handlers/notification-digests";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

import {
  asServiceRole,
  asUser,
  connect,
  count,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
  userJwt,
} from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;

async function insert(c: Client, sql: string, params: unknown[]): Promise<string> {
  const { rows } = await c.query<{ id: string }>(sql + " returning id", params);
  return rows[0].id;
}

describe.skipIf(!TEST_DATABASE_URL)("phase 13 tables, RLS and functions", () => {
  let c: Client;
  let alice: string; // admin A
  let carol: string; // agent A (no tasks.view, no inbox.view_all)
  let erin: string; // desk A (tasks.view, enquiries.view)
  let bob: string; // admin B
  let orgA: string;
  let orgB: string;
  let channelA: string;
  let contact1: string;
  const conv: Record<string, string> = {};

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    carol = await createAuthUser(c, "carol@example.test");
    erin = await createAuthUser(c, "erin@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
    await asServiceRole(c, async () => {
      const desk = await insert(
        c,
        "insert into public.roles (org_id, name, permissions) values ($1, 'Desk', $2::jsonb)",
        [orgA, JSON.stringify(["tasks.view", "enquiries.view", "inbox.send"])],
      );
      await c.query(
        "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)",
        [orgA, erin, desk],
      );
      const { rows: agentRole } = await c.query<{ id: string }>(
        "select id from public.roles where org_id = $1 and name = 'Agent'",
        [orgA],
      );
      await c.query(
        "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)",
        [orgA, carol, agentRole[0].id],
      );
      channelA = await insert(
        c,
        "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'A main', 'waba-a', 'pn-a')",
        [orgA],
      );
      contact1 = await insert(
        c,
        "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Pat', '+971500000001')",
        [orgA],
      );
      const contact2 = await insert(
        c,
        "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Sam', '+971500000002')",
        [orgA],
      );
      const contact3 = await insert(
        c,
        "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Lee', '+971500000003')",
        [orgA],
      );
      const contact4 = await insert(
        c,
        "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Kim', '+971500000004')",
        [orgA],
      );
      conv.unassigned = await insert(
        c,
        "insert into public.conversations (org_id, channel_id, contact_id, status, unread_count) values ($1, $2, $3, 'open', 2)",
        [orgA, channelA, contact1],
      );
      conv.carol = await insert(
        c,
        "insert into public.conversations (org_id, channel_id, contact_id, status, unread_count, assignee_user_id) values ($1, $2, $3, 'open', 1, $4)",
        [orgA, channelA, contact2, carol],
      );
      conv.waiting = await insert(
        c,
        "insert into public.conversations (org_id, channel_id, contact_id, status, unread_count, assignee_user_id) values ($1, $2, $3, 'waiting', 0, $4)",
        [orgA, channelA, contact3, alice],
      );
      conv.closed = await insert(
        c,
        "insert into public.conversations (org_id, channel_id, contact_id, status, unread_count) values ($1, $2, $3, 'closed', 5)",
        [orgA, channelA, contact4],
      );
      await c.query(
        "insert into public.tasks (org_id, subject, due_at, assignee_id) values ($1, 'overdue', now() - interval '1 hour', $2), ($1, 'later', now() + interval '1 day', $2), ($1, 'carols', now() - interval '1 hour', $3)",
        [orgA, erin, carol],
      );
      await c.query(
        "insert into public.tasks (org_id, subject, due_at, assignee_id, done, done_at) values ($1, 'finished', now() - interval '2 hour', $2, true, now())",
        [orgA, erin],
      );
      const pipeline = await insert(
        c,
        "insert into public.pipelines (org_id, name, is_default) values ($1, 'Main', true)",
        [orgA],
      );
      const stage = await insert(
        c,
        "insert into public.stages (org_id, pipeline_id, name, sort) values ($1, $2, 'New', 0)",
        [orgA, pipeline],
      );
      await c.query(
        "insert into public.enquiries (org_id, pipeline_id, stage_id, title) values ($1, $2, $3, 'e1'), ($1, $2, $3, 'e2')",
        [orgA, pipeline, stage],
      );
    });
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  describe("notification_preferences", () => {
    const insertPref = (event: string, channel: string, enabled = true, extra = "") =>
      c.query(
        `insert into public.notification_preferences (org_id, user_id, event, channel, enabled ${extra ? ", " + extra.split("=")[0] : ""}) values ($1, $2, $3, $4, $5 ${extra ? ", " + extra.split("=")[1] : ""})`,
        [orgA, carol, event, channel, enabled],
      );

    it("lets a member write, read and change their own rows, and nobody else's", async () => {
      await asUser(c, carol, async () => {
        await insertPref("task.due", "push", false);
        await c.query(
          "update public.notification_preferences set enabled = true where user_id = $1 and event = 'task.due'",
          [carol],
        );
        expect(await count(c, "select 1 from public.notification_preferences")).toBe(1);
        // someone else's row, in the same org
        await expect(
          c.query(
            "insert into public.notification_preferences (org_id, user_id, event, channel, enabled) values ($1, $2, 'task.due', 'email', true)",
            [orgA, alice],
          ),
        ).rejects.toMatchObject({ code: "42501" });
      });
      await asUser(c, alice, async () => {
        // an admin does not read other people's preferences either
        expect(await count(c, "select 1 from public.notification_preferences")).toBe(0);
      });
      await asUser(c, bob, async () => {
        expect(await count(c, "select 1 from public.notification_preferences")).toBe(0);
        const upd = await c.query("update public.notification_preferences set enabled = false");
        expect(upd.rowCount).toBe(0);
        const del = await c.query("delete from public.notification_preferences");
        expect(del.rowCount).toBe(0);
      });
    });

    it("refuses to write into an org the user does not belong to", async () => {
      await asUser(c, carol, async () => {
        await expect(
          c.query(
            "insert into public.notification_preferences (org_id, user_id, event, channel, enabled) values ($1, $2, 'task.due', 'email', true)",
            [orgB, carol],
          ),
        ).rejects.toMatchObject({ code: "42501" });
      });
    });

    it("keeps one row per user, event and channel, and validates the data", async () => {
      await asServiceRole(c, async () => {
        await expect(insertPref("task.due", "push")).rejects.toMatchObject({ code: "23505" });
        await expect(insertPref("Task Due", "email")).rejects.toMatchObject({ code: "23514" }); // event format
        await expect(insertPref("task.due", "sms")).rejects.toMatchObject({ code: "23514" }); // channel list
        await expect(
          insertPref("task.due", "email", true, "quiet_start='22:00'"),
        ).rejects.toMatchObject({ code: "23514" }); // quiet hours only on '*'
        await expect(insertPref("*", "email", true, "quiet_start='22:00'")).rejects.toMatchObject({
          code: "23514",
        }); // start without end
        await c.query(
          "insert into public.notification_preferences (org_id, user_id, event, channel, quiet_start, quiet_end) values ($1, $2, '*', 'push', '22:00', '07:00')",
          [orgA, carol],
        );
      });
    });
  });

  describe("push_subscriptions and the digest log", () => {
    it("shows a person only their own devices and digest history, and allows no client writes", async () => {
      await asServiceRole(c, async () => {
        await c.query(
          "insert into public.push_subscriptions (org_id, user_id, endpoint_hash, subscription_enc) values ($1, $2, repeat('b', 64), 'v1:a:b:c'), ($1, $3, repeat('c', 64), 'v1:a:b:c')",
          [orgA, carol, alice],
        );
        await c.query(
          "insert into public.notification_digest_log (org_id, user_id, kind, period_key) values ($1, $2, 'daily', '2026-10-12')",
          [orgA, carol],
        );
      });
      await asUser(c, carol, async () => {
        expect(await count(c, "select 1 from public.push_subscriptions")).toBe(1);
        expect(await count(c, "select 1 from public.notification_digest_log")).toBe(1);
        await expect(
          c.query(
            "insert into public.push_subscriptions (org_id, user_id, endpoint_hash, subscription_enc) values ($1, $2, repeat('d', 64), 'x')",
            [orgA, carol],
          ),
        ).rejects.toMatchObject({ code: "42501" });
        expect(
          (await c.query("update public.push_subscriptions set subscription_enc = 'tampered'"))
            .rowCount,
        ).toBe(0);
        expect((await c.query("delete from public.push_subscriptions")).rowCount).toBe(0);
        await expect(
          c.query(
            "insert into public.notification_digest_log (org_id, user_id, kind, period_key) values ($1, $2, 'weekly', 'x')",
            [orgA, carol],
          ),
        ).rejects.toMatchObject({ code: "42501" });
      });
      await asUser(c, bob, async () => {
        expect(await count(c, "select 1 from public.push_subscriptions")).toBe(0);
        expect(await count(c, "select 1 from public.notification_digest_log")).toBe(0);
      });
    });

    it("checks the endpoint hash shape, the digest kind and uniqueness", async () => {
      await asServiceRole(c, async () => {
        await expect(
          c.query(
            "insert into public.push_subscriptions (org_id, user_id, endpoint_hash, subscription_enc) values ($1, $2, 'short', 'x')",
            [orgA, carol],
          ),
        ).rejects.toMatchObject({ code: "23514" });
        await expect(
          c.query(
            "insert into public.push_subscriptions (org_id, user_id, endpoint_hash, subscription_enc) values ($1, $2, repeat('b', 64), 'x')",
            [orgA, carol],
          ),
        ).rejects.toMatchObject({ code: "23505" });
        await expect(
          c.query(
            "insert into public.notification_digest_log (org_id, user_id, kind, period_key) values ($1, $2, 'hourly', 'x')",
            [orgA, carol],
          ),
        ).rejects.toMatchObject({ code: "23514" });
        await expect(
          c.query(
            "insert into public.notification_digest_log (org_id, user_id, kind, period_key) values ($1, $2, 'daily', '2026-10-12')",
            [orgA, carol],
          ),
        ).rejects.toMatchObject({ code: "23505" });
      });
    });

    it("cascades with the org and the profile", async () => {
      const throwaway = await createAuthUser(c, "temp@example.test");
      await asServiceRole(c, async () => {
        const { rows } = await c.query<{ id: string }>(
          "select id from public.roles where org_id = $1 and name = 'Agent'",
          [orgA],
        );
        await c.query(
          "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)",
          [orgA, throwaway, rows[0].id],
        );
        await c.query(
          "insert into public.push_subscriptions (org_id, user_id, endpoint_hash, subscription_enc) values ($1, $2, repeat('e', 64), 'x')",
          [orgA, throwaway],
        );
        await c.query(
          "insert into public.notification_preferences (org_id, user_id, event, channel, enabled) values ($1, $2, 'task.due', 'push', false)",
          [orgA, throwaway],
        );
      });
      await c.query("delete from auth.users where id = $1", [throwaway]);
      expect(
        await count(c, "select 1 from public.push_subscriptions where user_id = $1", [throwaway]),
      ).toBe(0);
      expect(
        await count(c, "select 1 from public.notification_preferences where user_id = $1", [
          throwaway,
        ]),
      ).toBe(0);
    });
  });

  describe("notifications.snoozed_until", () => {
    it("lets a user snooze their own notification and no one else's", async () => {
      const mine = await asServiceRole(c, async () =>
        insert(
          c,
          "insert into public.notifications (org_id, user_id, type, title) values ($1, $2, 'task.due', 'mine')",
          [orgA, carol],
        ),
      );
      const alices = await asServiceRole(c, async () =>
        insert(
          c,
          "insert into public.notifications (org_id, user_id, type, title) values ($1, $2, 'task.due', 'hers')",
          [orgA, alice],
        ),
      );
      await asUser(c, carol, async () => {
        expect(
          (
            await c.query(
              "update public.notifications set snoozed_until = now() + interval '1 hour' where id = $1",
              [mine],
            )
          ).rowCount,
        ).toBe(1);
        expect(
          (
            await c.query(
              "update public.notifications set snoozed_until = now() + interval '1 hour' where id = $1",
              [alices],
            )
          ).rowCount,
        ).toBe(0);
      });
    });
  });

  describe("escalation columns", () => {
    it("starts at 0, only accepts 0 to 2, and is reset when someone takes the conversation", async () => {
      await asServiceRole(c, async () => {
        await expect(
          c.query("update public.conversations set escalation_level = 3 where id = $1", [
            conv.unassigned,
          ]),
        ).rejects.toMatchObject({ code: "23514" });
        await c.query("update public.conversations set escalation_level = 2 where id = $1", [
          conv.unassigned,
        ]);
        // unrelated update keeps the level
        await c.query("update public.conversations set unread_count = 3 where id = $1", [
          conv.unassigned,
        ]);
        expect(
          (
            await c.query("select escalation_level from public.conversations where id = $1", [
              conv.unassigned,
            ])
          ).rows[0].escalation_level,
        ).toBe(2);
        // un-assigning does not reset (the ladder continues), assigning does
        await c.query("update public.conversations set assignee_user_id = null where id = $1", [
          conv.unassigned,
        ]);
        expect(
          (
            await c.query("select escalation_level from public.conversations where id = $1", [
              conv.unassigned,
            ])
          ).rows[0].escalation_level,
        ).toBe(2);
        await c.query("update public.conversations set assignee_user_id = $2 where id = $1", [
          conv.unassigned,
          carol,
        ]);
        expect(
          (
            await c.query("select escalation_level from public.conversations where id = $1", [
              conv.unassigned,
            ])
          ).rows[0].escalation_level,
        ).toBe(0);
        await c.query(
          "update public.conversations set assignee_user_id = null, escalation_level = 0 where id = $1",
          [conv.unassigned],
        );
      });
    });

    it("lets a team have a lead, cleared if that person is removed", async () => {
      const other = await createAuthUser(c, "gone@example.test");
      await asServiceRole(c, async () => {
        const team = await insert(
          c,
          "insert into public.teams (org_id, name, lead_user_id) values ($1, 'Desk', $2)",
          [orgA, carol],
        );
        await c.query("update public.teams set lead_user_id = $2 where id = $1", [team, other]);
        await c.query("reset role");
        await c.query("delete from auth.users where id = $1", [other]);
        await c.query("set role service_role");
        expect(
          (await c.query("select lead_user_id from public.teams where id = $1", [team])).rows[0]
            .lead_user_id,
        ).toBeNull();
      });
    });
  });

  describe("dashboard_overview", () => {
    const call = (user: string, org: string, tasks = true, enquiries = true) =>
      asUser(c, user, async () => {
        const { rows } = await c.query<{ r: Record<string, unknown> }>(
          "select public.dashboard_overview($1, $2, date_trunc('day', now()), $3, $4) as r",
          [org, user, tasks, enquiries],
        );
        return rows[0].r as {
          conversations: { mine: number; unassigned: number; waiting: number; unread_mine: number };
          team: { members: number; online: number };
          tasks: { open: number; overdue: number } | null;
          enquiries: { open: number; new_today: number } | null;
        };
      });

    it("returns the same numbers the ten separate queries did, for a user who sees everything", async () => {
      const r = await call(alice, orgA);
      // open conversations: unassigned, carol's, alice's (closed excluded)
      expect(r.conversations).toEqual({ mine: 1, unassigned: 1, waiting: 1, unread_mine: 0 });
      expect(r.team).toEqual({ members: 3, online: 0 });
      expect(r.tasks).toEqual({ open: 0, overdue: 0 }); // alice has none
      expect(r.enquiries).toEqual({ open: 2, new_today: 2 });
    });

    it("counts a person's own open and overdue tasks, and honours the section switches", async () => {
      const r = await call(erin, orgA, true, false);
      expect(r.tasks).toEqual({ open: 2, overdue: 1 }); // the finished one does not count
      expect(r.enquiries).toBeNull();
      expect((await call(erin, orgA, false, true)).tasks).toBeNull();
      expect((await call(erin, orgA, false, true)).enquiries).toEqual({ open: 2, new_today: 2 });
    });

    it("lets row-level security decide: an agent only counts the conversations they can see", async () => {
      const r = await call(carol, orgA);
      // Agent: no inbox.view_all, no tasks.view. Carol sees her own conversation and the unowned one, not alice's.
      expect(r.conversations).toEqual({ mine: 1, unassigned: 1, waiting: 0, unread_mine: 1 });
      expect(r.tasks).toEqual({ open: 0, overdue: 0 }); // the "carols" task is hidden from her: no tasks.view
      expect(r.enquiries).toEqual({ open: 0, new_today: 0 });
    });

    it("shows another organisation's numbers to nobody", async () => {
      const r = await call(bob, orgA);
      expect(r.conversations).toEqual({ mine: 0, unassigned: 0, waiting: 0, unread_mine: 0 });
      expect(r.team).toEqual({ members: 0, online: 0 });
      expect(r.tasks).toEqual({ open: 0, overdue: 0 });
      expect(r.enquiries).toEqual({ open: 0, new_today: 0 });
    });

    it("is not callable by anon", async () => {
      await c.query("set role anon");
      try {
        await expect(
          c.query("select public.dashboard_overview($1, $2, now())", [orgA, alice]),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await c.query("reset role");
      }
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)(
  "phase 13 services through PostgREST",
  () => {
    let c: Client;
    let admin: AdminClient;
    let alice: string; // admin of the org
    let carol: string; // agent, team lead
    let dave: string; // agent, on call
    let org: string;
    let team: string;
    let channel: string;
    const queued = async (type: string) =>
      (
        await c.query<{ message: Record<string, unknown> }>(
          "select message from pgmq.q_notifications",
        )
      ).rows
        .map((r) => r.message)
        .filter((m) => m.type === type);

    beforeAll(async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = POSTGREST_URL;
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
      process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
      process.env.JOB_SECRET = "test-job-secret-0123456789";
      process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
      process.env.APP_URL = "https://pulse.test";

      c = await connect();
      await resetDb(c);
      alice = await createAuthUser(c, "alice@example.test");
      carol = await createAuthUser(c, "carol@example.test");
      dave = await createAuthUser(c, "dave@example.test");
      org = await createOrg(c, "Org A", "org-a", alice);
      admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
        auth: { persistSession: false },
      }) as unknown as AdminClient;
      // Make the module-level admin client talk to the test PostgREST too (dispatch-db and enqueue use it).
      await asServiceRole(c, async () => {
        const { rows } = await c.query<{ id: string }>(
          "select id from public.roles where org_id = $1 and name = 'Agent'",
          [org],
        );
        for (const u of [carol, dave])
          await c.query(
            "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)",
            [org, u, rows[0].id],
          );
        team = await insert(
          c,
          "insert into public.teams (org_id, name, lead_user_id) values ($1, 'Front desk', $2)",
          [org, carol],
        );
        await c.query(
          "insert into public.team_members (org_id, team_id, user_id) values ($1, $2, $3), ($1, $2, $4)",
          [org, team, carol, dave],
        );
        channel = await insert(
          c,
          "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'A main', 'waba-a', 'pn-a')",
          [org],
        );
        await c.query(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Sara', 'Example', '+971500000009')",
          [org],
        );
        await c.query("update public.profiles set first_name = 'Carol' where id = $1", [carol]);
      });
    });
    afterAll(async () => {
      await resetDb(c);
      await c.end();
    });

    describe("push store", () => {
      const sub = {
        endpoint: "https://fcm.googleapis.com/fcm/send/secret-device-token-123",
        keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) },
      };

      it("keeps the subscription encrypted at rest and round-trips it", async () => {
        await saveSubscription(admin, {
          orgId: org,
          userId: carol,
          subscription: sub,
          uaFamily: "Chrome on Android",
        });
        const { rows } = await c.query<{
          subscription_enc: string;
          endpoint_hash: string;
          ua_family: string;
        }>("select * from public.push_subscriptions where user_id = $1", [carol]);
        expect(rows).toHaveLength(1);
        expect(rows[0].endpoint_hash).toBe(endpointHash(sub.endpoint));
        expect(rows[0].subscription_enc).toMatch(/^v1:/);
        expect(rows[0].subscription_enc).not.toContain("secret-device-token");
        expect(rows[0].subscription_enc).not.toContain(sub.keys.auth);
        expect(decryptSubscription(rows[0].subscription_enc)).toEqual(sub);
      });

      it("is idempotent for the same device, lists, counts failures and removes", async () => {
        await saveSubscription(admin, {
          orgId: org,
          userId: carol,
          subscription: sub,
          uaFamily: "Chrome on Android",
        });
        expect(
          await count(c, "select 1 from public.push_subscriptions where user_id = $1", [carol]),
        ).toBe(1);
        const store = dbPushStore(admin);
        const devices = await store.list(org, carol);
        expect(devices).toHaveLength(1);
        await store.record(devices[0].id, false, 3);
        expect(
          (
            await c.query("select failure_count from public.push_subscriptions where id = $1", [
              devices[0].id,
            ])
          ).rows[0].failure_count,
        ).toBe(3);
        await store.record(devices[0].id, true, 0);
        const after = (
          await c.query(
            "select failure_count, last_used_at from public.push_subscriptions where id = $1",
            [devices[0].id],
          )
        ).rows[0];
        expect(after.failure_count).toBe(0);
        expect(after.last_used_at).not.toBeNull();
        expect(await store.list(org, dave)).toEqual([]);
        await removeSubscription(admin, { orgId: org, userId: dave, endpoint: sub.endpoint }); // someone else's call removes nothing
        expect(await store.list(org, carol)).toHaveLength(1);
        await removeSubscription(admin, { orgId: org, userId: carol, endpoint: sub.endpoint });
        expect(await store.list(org, carol)).toEqual([]);
      });
    });

    describe("notify (preferences, in-app rows, queued push and e-mail)", () => {
      it("records in-app, queues a push for people who have not opted out, and never puts the patient in the queue", async () => {
        await c.query("delete from pgmq.q_notifications");
        await asServiceRole(c, async () => {
          await c.query(
            "insert into public.notification_preferences (org_id, user_id, event, channel, enabled) values ($1, $2, 'inbox.assigned', 'push', false), ($1, $2, 'inbox.assigned', 'email', true)",
            [org, dave],
          );
        });
        const res = await notify(admin, {
          orgId: org,
          userIds: [carol, dave, "99999999-9999-4999-8999-999999999999"],
          event: "inbox.assigned",
          type: "inbox.assigned",
          title: "Conversation assigned to you",
          body: "With Sara Example +971500000009",
          payload: { conversation_id: "22222222-2222-4222-8222-222222222222" },
          ids: { conversation_id: "22222222-2222-4222-8222-222222222222" },
        });
        expect(res).toMatchObject({ in_app: 2, push: 1, email: 1, recipients: 2 });
        expect(
          await count(c, "select 1 from public.notifications where type = 'inbox.assigned'"),
        ).toBe(2);
        const push = await queued("push");
        expect(push).toHaveLength(1);
        expect(push[0]).toMatchObject({ user_id: carol, event: "inbox.assigned" });
        const mail = await queued("email");
        expect(mail).toHaveLength(1);
        const everything = JSON.stringify([...push, ...mail]);
        for (const secret of ["Sara", "Example", "+971500000009"])
          expect(everything).not.toContain(secret);
      });

      it("finds members by permission, honouring wildcards", async () => {
        expect((await memberIdsWithPermission(admin, org, "settings.manage")).sort()).toEqual(
          [alice].sort(),
        );
        expect((await memberIdsWithPermission(admin, org, "inbox.send")).sort()).toEqual(
          [alice, carol, dave].sort(),
        );
      });
    });

    describe("escalation ladder", () => {
      async function newConversation(phone: string) {
        const contact = await asServiceRole(c, async () =>
          insert(
            c,
            "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'X', $2)",
            [org, phone],
          ),
        );
        return asServiceRole(c, async () =>
          insert(
            c,
            "insert into public.conversations (org_id, channel_id, contact_id, status, unread_count, assignee_team_id) values ($1, $2, $3, 'open', 1, $4)",
            [org, channel, contact, team],
          ),
        );
      }
      const enable = (extra: Record<string, unknown> = {}) =>
        asServiceRole(c, async () => {
          await c.query(
            "update public.orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{escalation}', $2::jsonb) where id = $1",
            [
              org,
              JSON.stringify({
                enabled: true,
                lead_after_minutes: 10,
                on_call_after_minutes: 25,
                on_call_user_ids: [dave],
                ...extra,
              }),
            ],
          );
        });

      it("does nothing while escalation is switched off", async () => {
        const conversation = await newConversation("+971500000011");
        expect(
          await scheduleFirstEscalation(
            org,
            {},
            { id: conversation, assignee_user_id: null, escalation_level: 0 },
          ),
        ).toBe(false);
        expect(
          await count(c, "select 1 from public.scheduled_jobs where kind = 'inbox.escalate'"),
        ).toBe(0);
      });

      it("walks the ladder: lead first, then on-call, one notification each, idempotent", async () => {
        await enable();
        await c.query("delete from pgmq.q_notifications");
        const conversation = await newConversation("+971500000012");
        const settings = {
          escalation: {
            enabled: true,
            lead_after_minutes: 10,
            on_call_after_minutes: 25,
            on_call_user_ids: [dave],
          },
        };

        expect(
          await scheduleFirstEscalation(org, settings, {
            id: conversation,
            assignee_user_id: null,
            escalation_level: 0,
          }),
        ).toBe(true);
        // a second inbound message does not stack another job
        expect(
          await scheduleFirstEscalation(org, settings, {
            id: conversation,
            assignee_user_id: null,
            escalation_level: 0,
          }),
        ).toBe(false);
        const job1 = (
          await c.query<{ run_at: string; payload: { level: number } }>(
            "select run_at, payload from public.scheduled_jobs where kind = 'inbox.escalate'",
          )
        ).rows;
        expect(job1).toHaveLength(1);
        expect(job1[0].payload.level).toBe(1);
        const delayMin = (new Date(job1[0].run_at).getTime() - Date.now()) / 60_000;
        expect(delayMin).toBeGreaterThan(9);
        expect(delayMin).toBeLessThan(11);

        // rung 1: the team lead (carol) is told, the level is claimed, rung 2 is scheduled 15 minutes later
        expect(
          await handleEscalation(admin, org, { conversation_id: conversation, level: 1 }),
        ).toBe("escalated:1:1");
        const n1 = (
          await c.query<{ user_id: string; title: string; body: string }>(
            "select user_id, title, body from public.notifications where type = 'escalation' and payload->>'conversation_id' = $1",
            [conversation],
          )
        ).rows;
        expect(n1).toEqual([expect.objectContaining({ user_id: carol })]);
        expect(`${n1[0].title} ${n1[0].body}`).not.toMatch(/Sara|Example|\+971|X/);
        expect(
          (
            await c.query("select escalation_level from public.conversations where id = $1", [
              conversation,
            ])
          ).rows[0].escalation_level,
        ).toBe(1);
        const job2 = (
          await c.query<{ run_at: string; payload: { level: number } }>(
            "select run_at, payload from public.scheduled_jobs where kind = 'inbox.escalate' and payload->>'level' = '2'",
          )
        ).rows;
        expect(job2).toHaveLength(1);
        expect((new Date(job2[0].run_at).getTime() - Date.now()) / 60_000).toBeGreaterThan(14);
        expect(await queued("push")).toEqual([
          expect.objectContaining({ user_id: carol, event: "escalation" }),
        ]);

        // the same rung again (a retried job) tells nobody twice
        expect(
          await handleEscalation(admin, org, { conversation_id: conversation, level: 1 }),
        ).toBe("skipped:already_escalated");
        expect(
          await count(
            c,
            "select 1 from public.notifications where type = 'escalation' and payload->>'conversation_id' = $1",
            [conversation],
          ),
        ).toBe(1);

        // rung 2: the on-call person (dave)
        expect(
          await handleEscalation(admin, org, { conversation_id: conversation, level: 2 }),
        ).toBe("escalated:2:1");
        expect(
          (
            await c.query(
              "select user_id from public.notifications where type = 'escalation' and payload->>'level' = '2'",
            )
          ).rows,
        ).toEqual([{ user_id: dave }]);
        expect(
          (
            await c.query("select escalation_level from public.conversations where id = $1", [
              conversation,
            ])
          ).rows[0].escalation_level,
        ).toBe(2);
      });

      it("stands down once someone takes the conversation, and for a closed one", async () => {
        await enable();
        const taken = await newConversation("+971500000013");
        await asServiceRole(
          c,
          async () =>
            void (await c.query(
              "update public.conversations set assignee_user_id = $2 where id = $1",
              [taken, carol],
            )),
        );
        expect(await handleEscalation(admin, org, { conversation_id: taken, level: 1 })).toBe(
          "skipped:assigned",
        );

        const closed = await newConversation("+971500000014");
        await asServiceRole(
          c,
          async () =>
            void (await c.query("update public.conversations set status = 'closed' where id = $1", [
              closed,
            ])),
        );
        expect(await handleEscalation(admin, org, { conversation_id: closed, level: 1 })).toBe(
          "skipped:closed",
        );
        expect(
          await handleEscalation(admin, org, {
            conversation_id: "99999999-9999-4999-8999-999999999999",
            level: 1,
          }),
        ).toBe("skipped:missing");
      });

      it("falls back to administrators at rung 2 when no on-call list is set, and rejects a bad payload", async () => {
        await enable({ on_call_user_ids: [] });
        const conversation = await newConversation("+971500000015");
        await asServiceRole(
          c,
          async () =>
            void (await c.query(
              "update public.conversations set escalation_level = 1 where id = $1",
              [conversation],
            )),
        );
        expect(
          await handleEscalation(admin, org, { conversation_id: conversation, level: 2 }),
        ).toBe("escalated:2:1");
        expect(
          (
            await c.query(
              "select user_id from public.notifications where type = 'escalation' and payload->>'conversation_id' = $1",
              [conversation],
            )
          ).rows,
        ).toEqual([{ user_id: alice }]);
        await expect(
          handleEscalation(admin, org, { conversation_id: "nope", level: 1 }),
        ).rejects.toThrow(/invalid inbox.escalate payload/);
      });
    });

    describe("the inbound message hook (processInbound)", () => {
    const fixture = JSON.parse(readFileSync(path.join(process.cwd(), "scripts/wa-fixtures/message-text.json"), "utf8"));
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const inbound = async (waId: string, wamid: string, phone: string, phoneNumberId: string) => {
      const body = structuredClone(fixture);
      const value = body.entry[0].changes[0].value;
      value.metadata.phone_number_id = phoneNumberId;
      value.contacts[0].wa_id = phone.replace("+", "");
      value.messages[0].from = phone.replace("+", "");
      value.messages[0].id = wamid;
      const parsed = parseWebhookBody(body);
      if (!parsed.ok) throw new Error("fixture did not parse");
      const event = parsed.events.find((e) => e.kind === "message");
      if (!event || event.kind !== "message") throw new Error("no message event");
      return processInbound(admin, event, log);
    };

    it("tells the owner about the first unread message only, with no patient details in the queued push", async () => {
      await c.query("delete from pgmq.q_notifications");
      const pnid = "pn-hook-owned";
      await asServiceRole(c, async () => {
        await c.query("insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'Hook A', 'waba-h', $2)", [org, pnid]);
      });
      const phone = "+971500000021";
      const contact = await asServiceRole(c, async () => insert(c, "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Hana', 'Hook', $2)", [org, phone]));
      const channelId = (await c.query<{ id: string }>("select id from public.channels where phone_number_id = $1", [pnid])).rows[0].id;
      await asServiceRole(c, async () => insert(c, "insert into public.conversations (org_id, channel_id, contact_id, status, unread_count, assignee_user_id) values ($1, $2, $3, 'open', 0, $4)", [org, channelId, contact, carol]));

      expect(await inbound("w", "wamid.HOOK_1", phone, pnid)).toMatchObject({ outcome: "stored" });
      expect(await count(c, "select 1 from public.notifications where user_id = $1 and type = 'inbox.message'", [carol])).toBe(1);
      const pushes = await queued("push");
      expect(pushes).toEqual([expect.objectContaining({ user_id: carol, event: "inbox.message" })]);
      expect(JSON.stringify(pushes)).not.toMatch(/Hana|Hook|Hello|book an appointment|971500000021/);

      // a second message while the first is still unread does not ping again
      expect(await inbound("w", "wamid.HOOK_2", phone, pnid)).toMatchObject({ outcome: "stored" });
      expect(await count(c, "select 1 from public.notifications where user_id = $1 and type = 'inbox.message'", [carol])).toBe(1);
      // and a redelivered webhook changes nothing
      expect(await inbound("w", "wamid.HOOK_2", phone, pnid)).toMatchObject({ outcome: "duplicate" });
    });

    it("starts the escalation ladder when nobody owns the conversation, once, and only when enabled", async () => {
      const pnid = "pn-hook-unowned";
      await asServiceRole(c, async () => {
        await c.query("insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'Hook B', 'waba-h2', $2)", [org, pnid]);
        await c.query("update public.orgs set settings = jsonb_build_object('escalation', jsonb_build_object('enabled', false)) where id = $1", [org]);
      });
      await c.query("delete from public.scheduled_jobs where kind = 'inbox.escalate'");
      await inbound("w", "wamid.HOOK_3", "+971500000022", pnid);
      expect(await count(c, "select 1 from public.scheduled_jobs where kind = 'inbox.escalate'")).toBe(0); // switched off

      await asServiceRole(c, async () => {
        await c.query("update public.orgs set settings = jsonb_build_object('escalation', jsonb_build_object('enabled', true, 'lead_after_minutes', 5, 'on_call_after_minutes', 15)) where id = $1", [org]);
      });
      await inbound("w", "wamid.HOOK_4", "+971500000022", pnid);
      await inbound("w", "wamid.HOOK_5", "+971500000022", pnid); // same conversation, second message
      const jobs = (await c.query<{ payload: { conversation_id: string; level: number } }>("select payload from public.scheduled_jobs where kind = 'inbox.escalate'")).rows;
      expect(jobs).toHaveLength(1);
      expect(jobs[0].payload.level).toBe(1);
      const conv = await c.query("select assignee_user_id from public.conversations where id = $1", [jobs[0].payload.conversation_id]);
      expect(conv.rows[0].assignee_user_id).toBeNull();
    });
  });

  describe("management digests", () => {
      it("sends each opted-in person one digest per period, with the dashboard's numbers, once", async () => {
        await c.query("delete from pgmq.q_notifications");
        await asServiceRole(c, async () => {
          await c.query("update public.orgs set timezone = 'Asia/Dubai' where id = $1", [org]);
          // alice (admin) opts in to the daily digest; dave (agent, no reports.view) tries to; carol did not
          await c.query(
            "insert into public.notification_preferences (org_id, user_id, event, channel, enabled) values ($1, $2, 'digest.daily', 'email', true), ($1, $3, 'digest.daily', 'email', true)",
            [org, alice, dave],
          );
        });
        const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const sevenThirtyDubai = new Date("2026-10-13T03:30:00Z");
        const first = await runDigests(admin, log, sevenThirtyDubai);
        expect(first).toMatchObject({ orgs: 1, queued: 1, skipped_already_sent: 0, failed: 0 });
        const mail = await queued("email");
        expect(mail).toHaveLength(1);
        expect(mail[0]).toMatchObject({ to: "alice@example.test" });
        expect(String(mail[0].subject)).toContain("Daily digest");
        expect(String(mail[0].subject)).toContain("2026-10-12");
        expect(String(mail[0].text)).toContain(
          "Open the dashboard: https://pulse.test/dashboard/management",
        );
        expect(
          await count(
            c,
            "select 1 from public.notification_digest_log where user_id = $1 and kind = 'daily' and period_key = '2026-10-12'",
            [alice],
          ),
        ).toBe(1);

        // a second tick inside the window sends nothing more
        const again = await runDigests(admin, log, new Date("2026-10-13T04:35:00Z"));
        expect(again).toMatchObject({ queued: 0, skipped_already_sent: 1 });
        expect(await queued("email")).toHaveLength(1);

        // outside the window nothing is even considered
        expect(await runDigests(admin, log, new Date("2026-10-13T12:00:00Z"))).toMatchObject({
          orgs: 0,
          queued: 0,
        });
      });
    });

    describe("public API read audit (found in the index review)", () => {
      it("really samples: two reads by one key in the window leave one audit row (the lookup used a column audit_log does not have)", async () => {
        const ctx = {
          keyId: "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a",
          orgId: org,
          scopes: ["contacts:read"],
        };
        await auditApiRead(admin, ctx, "contacts", 10);
        await auditApiRead(admin, ctx, "contacts", 12);
        expect(
          await count(
            c,
            "select 1 from public.audit_log where org_id = $1 and action = 'api.contacts_read'",
            [org],
          ),
        ).toBe(1);
        await auditApiRead(admin, ctx, "enquiries", 3); // another resource gets its own row
        expect(
          await count(
            c,
            "select 1 from public.audit_log where org_id = $1 and action like 'api.%_read'",
            [org],
          ),
        ).toBe(2);
      });
    });

    describe("notification centre filters (real PostgREST syntax)", () => {
      it("filters by status and category for the signed-in user only", async () => {
        await asServiceRole(c, async () => {
          await c.query("delete from public.notifications where user_id = $1", [dave]);
          const mk = (type: string, extra = "") =>
            c.query(
              `insert into public.notifications (org_id, user_id, type, title ${extra ? ", " + extra.split("=")[0] : ""}) values ($1, $2, $3, $3 ${extra ? ", " + extra.split("=")[1] : ""})`,
              [org, dave, type],
            );
          await mk("mention");
          await mk("inbox.assigned");
          await mk("task.due");
          await mk("escalation");
          await mk("security.alert");
          await mk("finance.alert");
          await mk("integration.unite_paused");
          await mk("task.due", "snoozed_until=now() + interval '2 hours'");
          await mk("inbox.message", "read_at=now()");
          await c.query(
            "insert into public.notifications (org_id, user_id, type, title) values ($1, $2, 'task.due', 'someone elses')",
            [org, carol],
          );
        });
        const user = createClient<Database>(POSTGREST_URL!, "test-anon", {
          global: { headers: { Authorization: `Bearer ${userJwt(dave)}` } },
          auth: { persistSession: false },
        });
        const run = async (opts: Parameters<typeof applyCentreFilters>[1]) => {
          const q = user
            .from("notifications")
            .select("type, title, read_at, snoozed_until")
            .eq("org_id", org)
            .eq("user_id", dave);
          const { data, error } = await applyCentreFilters(q, opts);
          expect(error).toBeNull();
          return (data ?? []).map((r) => r.type).sort();
        };
        const nowIso = new Date().toISOString();
        expect(await run({ status: "all", category: null, nowIso })).toEqual([
          "escalation",
          "finance.alert",
          "inbox.assigned",
          "inbox.message",
          "integration.unite_paused",
          "mention",
          "security.alert",
          "task.due",
        ]);
        expect(await run({ status: "unread", category: null, nowIso })).not.toContain(
          "inbox.message",
        );
        expect(await run({ status: "snoozed", category: null, nowIso })).toEqual(["task.due"]);
        expect(await run({ status: "all", category: "inbox", nowIso })).toEqual([
          "inbox.assigned",
          "inbox.message",
          "mention",
        ]);
        expect(await run({ status: "all", category: "work", nowIso })).toEqual(["task.due"]);
        expect(await run({ status: "all", category: "escalation", nowIso })).toEqual([
          "escalation",
        ]);
        expect(await run({ status: "all", category: "security", nowIso })).toEqual([
          "security.alert",
        ]);
        expect(await run({ status: "all", category: "system", nowIso })).toEqual([
          "finance.alert",
          "integration.unite_paused",
        ]);
        expect(await run({ status: "unread", category: "inbox", nowIso })).toEqual([
          "inbox.assigned",
          "mention",
        ]);
        // a snoozed item returns once its time has passed
        expect(
          await run({
            status: "all",
            category: "work",
            nowIso: new Date(Date.now() + 3 * 3_600_000).toISOString(),
          }),
        ).toEqual(["task.due", "task.due"]);
      });
    });
  },
);
