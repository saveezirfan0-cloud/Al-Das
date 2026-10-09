/**
 * Metrics layer: materialized views, live views, refresh + discovery RPCs.
 * Checks the working metric definitions (docs/audit/reports.md) against fixtures whose answers
 * are computed by hand, including org-timezone day bucketing. Runs only with TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("metrics views", () => {
  let c: Client;
  let alice: string; // admin A, the staff member who replies
  let bob: string; // admin B
  let orgA: string;
  let orgB: string;
  let channelA: string;
  const conv: Record<string, string> = {};

  async function insert(sql: string, params: unknown[]): Promise<string> {
    const { rows } = await c.query<{ id: string }>(sql + " returning id", params);
    return rows[0].id;
  }

  async function message(
    conversation: string,
    org: string,
    direction: "in" | "out",
    at: string,
    sentBy: string | null = null,
    kind = "text",
    status = direction === "in" ? "received" : "sent",
  ) {
    await c.query(
      "insert into public.messages (org_id, conversation_id, direction, kind, body, at, status, sent_by_user_id) values ($1, $2, $3, $4, 'x', $5, $6, $7)",
      [org, conversation, direction, kind, at, status, sentBy],
    );
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);

    await asServiceRole(c, async () => {
      // Org A is in Asia/Dubai (UTC+4), the orgs.timezone default.
      channelA = await insert(
        "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'A', 'waba-a', 'pn-a')",
        [orgA],
      );
      const channelB = await insert(
        "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'B', 'waba-b', 'pn-b')",
        [orgB],
      );
      const pat = await insert(
        "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Pat', '+971500000001')",
        [orgA],
      );
      const sam = await insert(
        "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Sam', '+971500000002')",
        [orgA],
      );
      const other = await insert(
        "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Org B contact', '+971500000009')",
        [orgB],
      );

      // conv1: Pat writes 2026-01-10 23:30 UTC (= 2026-01-11 03:30 Dubai). Alice replies after 300s.
      // Closed by Alice 2026-01-11 00:30 UTC -> resolution 3600s.
      conv.one = await insert(
        `insert into public.conversations (org_id, channel_id, contact_id, status, opened_at, closed_at, closed_by, last_inbound_at, last_message_direction)
         values ($1, $2, $3, 'closed', '2026-01-10T23:30:00Z', '2026-01-11T00:30:00Z', $4, '2026-01-10T23:30:00Z', 'out')`,
        [orgA, channelA, pat, alice],
      );
      await message(conv.one, orgA, "in", "2026-01-10T23:30:00Z");
      await message(conv.one, orgA, "out", "2026-01-10T23:35:00Z", alice);

      // conv2: Pat again (returning). A flow/bot replies first (no sent_by_user_id) and is NOT a first
      // response; Alice replies at +600s. Assigned to Alice and still open.
      conv.two = await insert(
        `insert into public.conversations (org_id, channel_id, contact_id, status, assignee_user_id, opened_at, last_inbound_at, last_message_direction)
         values ($1, $2, $3, 'open', $4, '2026-01-12T06:00:00Z', '2026-01-12T06:00:00Z', 'out')`,
        [orgA, channelA, pat, alice],
      );
      await message(conv.two, orgA, "in", "2026-01-12T06:00:00Z");
      await message(conv.two, orgA, "out", "2026-01-12T06:01:00Z", null, "template");
      await message(conv.two, orgA, "out", "2026-01-12T06:10:00Z", alice);

      // conv3: Sam wrote and nobody replied: an SLA breach, no first response.
      conv.three = await insert(
        `insert into public.conversations (org_id, channel_id, contact_id, status, opened_at, last_inbound_at, last_message_direction)
         values ($1, $2, $3, 'open', '2026-01-12T07:00:00Z', '2026-01-12T07:00:00Z', 'in')`,
        [orgA, channelA, sam],
      );
      await message(conv.three, orgA, "in", "2026-01-12T07:00:00Z");

      // Org B noise that must never leak into org A's numbers.
      const convB = await insert(
        `insert into public.conversations (org_id, channel_id, contact_id, status, opened_at)
         values ($1, $2, $3, 'open', '2026-01-12T08:00:00Z')`,
        [orgB, channelB, other],
      );
      await message(convB, orgB, "in", "2026-01-12T08:00:00Z");

      await c.query("select public.refresh_metrics()");
    });
  });

  afterAll(async () => {
    await c?.end();
  });

  const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    asServiceRole(c, async () => (await c.query<T>(sql, params)).rows);

  it("computes first response, resolution, returning and the org-timezone day per conversation", async () => {
    const rows = await q<{
      conversation_id: string;
      opened_day: Date | string;
      first_response_seconds: number | null;
      resolution_seconds: number | null;
      is_returning: boolean;
      inbound_count: number;
      outbound_count: number;
    }>(
      "select conversation_id, opened_day::text, first_response_seconds, resolution_seconds, is_returning, inbound_count, outbound_count from public.mv_conversation_facts where org_id = $1",
      [orgA],
    );
    const by = Object.fromEntries(rows.map((r) => [r.conversation_id, r]));

    expect(by[conv.one]).toMatchObject({
      opened_day: "2026-01-11", // 23:30 UTC on the 10th is already the 11th in Dubai
      first_response_seconds: 300,
      resolution_seconds: 3600,
      is_returning: false,
      inbound_count: 1,
      outbound_count: 1,
    });
    expect(by[conv.two]).toMatchObject({
      opened_day: "2026-01-12",
      first_response_seconds: 600, // the unattributed template at +60s does not count
      resolution_seconds: null,
      is_returning: true,
      outbound_count: 2,
    });
    expect(by[conv.three]).toMatchObject({ first_response_seconds: null, is_returning: false });
    expect(rows).toHaveLength(3); // org B's conversation is not in org A's rows
  });

  it("rolls conversations up per day and channel, with unique and returning contacts", async () => {
    const rows = await q<Record<string, number | string>>(
      "select day::text, opened, closed, unique_contacts, returning_contacts, inbound_messages, outbound_messages from public.mv_daily_conversations where org_id = $1 and channel_id = $2 order by day",
      [orgA, channelA],
    );
    expect(rows).toEqual([
      // 2026-01-10 23:30 UTC is 2026-01-11 03:30 in Dubai, so conv1's messages land on the 11th
      {
        day: "2026-01-11",
        opened: 1,
        closed: 1,
        unique_contacts: 1,
        returning_contacts: 0,
        inbound_messages: 1,
        outbound_messages: 1,
      },
      {
        day: "2026-01-12",
        opened: 2,
        closed: 0,
        unique_contacts: 2,
        returning_contacts: 1,
        inbound_messages: 2,
        outbound_messages: 2,
      },
    ]);
  });

  it("buckets the hour x day heatmap source in the org timezone", async () => {
    const rows = await q<{ day: string; hour: number; inbound_messages: number }>(
      "select day::text, hour, inbound_messages from public.mv_hourly_conversations where org_id = $1 and inbound_messages > 0 order by day, hour",
      [orgA],
    );
    expect(rows).toEqual([
      { day: "2026-01-11", hour: 3, inbound_messages: 1 }, // 23:30 UTC = 03:30 Dubai
      { day: "2026-01-12", hour: 10, inbound_messages: 1 }, // 06:00 UTC
      { day: "2026-01-12", hour: 11, inbound_messages: 1 }, // 07:00 UTC
    ]);
  });

  it("attributes agent performance to the staff member, excluding bot messages", async () => {
    const rows = await q<Record<string, number | string>>(
      "select day::text, messages_sent, conversations_handled, first_response_count, first_response_seconds_sum::int as fr_sum, conversations_closed, resolution_seconds_sum::int as res_sum from public.mv_agent_performance where org_id = $1 and user_id = $2 order by day",
      [orgA, alice],
    );
    expect(rows).toEqual([
      {
        day: "2026-01-11",
        messages_sent: 1,
        conversations_handled: 1,
        first_response_count: 1,
        fr_sum: 300,
        conversations_closed: 1,
        res_sum: 3600,
      },
      {
        day: "2026-01-12",
        messages_sent: 1, // the template sent without a user is not hers
        conversations_handled: 1,
        first_response_count: 1,
        fr_sum: 600,
        conversations_closed: 0,
        res_sum: 0,
      },
    ]);
  });

  it("splits outbound usage into template vs free-form by status", async () => {
    const rows = await q<{ category: string; status: string; messages: number }>(
      "select category, status, sum(messages)::int as messages from public.mv_message_usage_daily where org_id = $1 group by category, status order by category, status",
      [orgA],
    );
    expect(rows).toEqual([
      { category: "free_form", status: "sent", messages: 2 },
      { category: "template", status: "sent", messages: 1 },
    ]);
  });

  it("live views: queue counts, workload and SLA breaches", async () => {
    const queue = await q<{ open_count: number; unassigned_count: number }>(
      "select sum(open_count)::int as open_count, sum(unassigned_count)::int as unassigned_count from public.v_team_queue_now where org_id = $1",
      [orgA],
    );
    expect(queue[0]).toEqual({ open_count: 2, unassigned_count: 1 }); // conv2 + conv3 open; conv3 unassigned

    const load = await q<{ open_conversations: number }>(
      "select open_conversations from public.v_agent_workload_now where org_id = $1 and user_id = $2",
      [orgA, alice],
    );
    expect(load[0].open_conversations).toBe(1);

    // Only conv3: the patient wrote last and the default 15 minute SLA is long past.
    const breaches = await q<{ conversation_id: string }>(
      "select conversation_id from public.v_sla_breaches_now where org_id = $1",
      [orgA],
    );
    expect(breaches.map((b) => b.conversation_id)).toEqual([conv.three]);
  });

  it("honours the per-org SLA threshold from settings", async () => {
    await asServiceRole(c, async () => {
      await c.query(
        "update public.orgs set settings = jsonb_set(settings, '{reports}', '{\"sla_minutes\": 10000000}') where id = $1",
        [orgA],
      );
    });
    const none = await q("select 1 from public.v_sla_breaches_now where org_id = $1", [orgA]);
    expect(none).toHaveLength(0);
  });

  it("refresh_metrics validates names and reports what it refreshed", async () => {
    await asServiceRole(c, async () => {
      const one = await c.query<{ r: string[] }>("select public.refresh_metrics('mv_daily_conversations') as r");
      expect(one.rows[0].r).toEqual(["mv_daily_conversations"]);
      await expect(c.query("select public.refresh_metrics('pg_class')")).rejects.toThrow(/unknown metrics view/);
      const all = await c.query<{ r: string[] }>("select public.refresh_metrics() as r");
      expect(all.rows[0].r).toHaveLength(5);
      expect(all.rows[0].r[0]).toBe("mv_conversation_facts"); // dependency order
    });
  });

  it("report_sources_available lists the views that exist", async () => {
    const rows = await q<{ s: string[] }>("select public.report_sources_available() as s");
    expect(rows[0].s).toEqual(
      expect.arrayContaining([
        "mv_conversation_facts",
        "mv_daily_conversations",
        "mv_agent_performance",
        "v_sla_breaches_now",
      ]),
    );
    expect(rows[0].s).not.toContain("mv_enquiry_funnel"); // arrives with Phase 5
  });

  it("materialized views and the refresh RPC are closed to API roles", async () => {
    await asUser(c, alice, async () => {
      for (const mv of [
        "mv_conversation_facts",
        "mv_daily_conversations",
        "mv_hourly_conversations",
        "mv_agent_performance",
        "mv_message_usage_daily",
      ]) {
        await expect(c.query(`select 1 from public.${mv}`), mv).rejects.toThrow(/permission denied/);
      }
      await expect(c.query("select public.refresh_metrics()")).rejects.toThrow(/permission denied/);
      await expect(c.query("select public.report_sources_available()")).rejects.toThrow(/permission denied/);
    });
  });

  it("live views respect the caller's RLS", async () => {
    // Org B's admin sees only org B through the security_invoker view.
    await asUser(c, bob, async () => {
      const { rows } = await c.query("select org_id from public.v_team_queue_now");
      expect(rows.every((r) => r.org_id === orgB)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
    });
  });
  describe("report functions", () => {
    const FROM = "2026-01-11";
    const TO = "2026-01-12";
    const none = "00000000-0000-4000-8000-000000000000";
    const call = async <T extends Record<string, unknown>>(fn: string, args: unknown[]) =>
      q<T>(`select * from public.${fn}($1, $2, $3${args.length ? ", " + args.map((_, i) => `$${i + 4}`).join(", ") : ""})`, [orgA, FROM, TO, ...args]);

    it("summarises conversations, contacts and messages for the period", async () => {
      const [r] = await call<Record<string, number>>("report_conversations_summary", []);
      expect(r).toEqual({
        conversations: 3,
        closed: 1,
        still_open: 2,
        unique_contacts: 2,
        returning_contacts: 1,
        inbound_messages: 3,
        outbound_messages: 3,
      });
    });

    it("returns one row per day, zero-filled, with closed counted on the day it closed", async () => {
      const rows = await q<Record<string, number | string>>(
        "select day::text, opened, closed, inbound_messages, outbound_messages from public.report_conversations_by_day($1, '2026-01-10', $2)",
        [orgA, TO],
      );
      expect(rows).toEqual([
        { day: "2026-01-10", opened: 0, closed: 0, inbound_messages: 0, outbound_messages: 0 },
        { day: "2026-01-11", opened: 1, closed: 1, inbound_messages: 1, outbound_messages: 1 },
        { day: "2026-01-12", opened: 2, closed: 0, inbound_messages: 2, outbound_messages: 2 },
      ]);
    });

    it("groups by channel with names", async () => {
      const rows = await call<{ channel_id: string; channel_name: string; conversations: number }>("report_conversations_by_channel", []);
      expect(rows).toEqual([{ channel_id: channelA, channel_name: "A", conversations: 3 }]);
    });

    it("builds the weekday x hour heatmap in the org timezone (0 = Sunday)", async () => {
      const rows = await call<{ dow: number; hour: number; inbound_messages: number }>("report_heatmap", []);
      expect(rows).toEqual([
        { dow: 0, hour: 3, inbound_messages: 1 }, // Sun 2026-01-11 03:30 Dubai
        { dow: 1, hour: 10, inbound_messages: 1 }, // Mon 2026-01-12 10:00
        { dow: 1, hour: 11, inbound_messages: 1 }, // Mon 11:00
      ]);
    });

    it("computes response-time statistics and buckets", async () => {
      const [r] = await call<Record<string, string | number | null>>("report_response_summary", []);
      expect(r).toMatchObject({ conversations: 3, answered: 2, unanswered: 1, resolved: 1 });
      expect(Number(r.fr_avg_seconds)).toBe(450);
      expect(Number(r.fr_median_seconds)).toBe(450);
      expect(Number(r.res_avg_seconds)).toBe(3600);
      // 300s and 600s both fall in [5m, 15m)
      expect(r).toMatchObject({ within_5m: 0, within_15m: 2, within_1h: 0, within_4h: 0, over_4h: 0 });
    });

    it("re-aggregates agents exactly and honours user and team filters", async () => {
      const [a] = await call<Record<string, string | number | null>>("report_agents", []);
      expect(a).toMatchObject({ user_id: alice, messages_sent: 2, first_responses: 2, conversations_closed: 1 });
      expect(Number(a.avg_first_response_seconds)).toBe(450);
      expect(Number(a.avg_resolution_seconds)).toBe(3600);
      expect(await call("report_agents", [[bob]])).toHaveLength(0);
      expect(await call("report_agents", [null, [none]])).toHaveLength(0); // a team nobody is in
    });

    it("applies channel and team filters to conversation numbers", async () => {
      const [byChannel] = await call<Record<string, number>>("report_conversations_summary", [[none]]);
      expect(byChannel.conversations).toBe(0);
      const [byTeam] = await call<Record<string, number>>("report_conversations_summary", [null, [none]]);
      expect(byTeam.conversations).toBe(0);
      const [mine] = await call<Record<string, number>>("report_conversations_summary", [[channelA]]);
      expect(mine.conversations).toBe(3);
    });

    it("reports outbound usage by day and in total", async () => {
      const days = await q<Record<string, number | string>>(
        "select day::text, template, free_form, failed from public.report_usage_by_day($1, $2, $3)",
        [orgA, FROM, TO],
      );
      expect(days).toEqual([
        { day: "2026-01-11", template: 0, free_form: 1, failed: 0 },
        { day: "2026-01-12", template: 1, free_form: 1, failed: 0 },
      ]);
      const totals = await call<{ category: string; status: string; messages: number }>("report_usage_totals", []);
      expect(totals).toEqual([
        { category: "free_form", status: "sent", messages: 2 },
        { category: "template", status: "sent", messages: 1 },
      ]);
    });

    it("never mixes in another org and is closed to API roles", async () => {
      const [other] = await q<Record<string, number>>("select * from public.report_conversations_summary($1, $2, $3)", [orgB, FROM, TO]);
      expect(other.conversations).toBe(1);
      await asUser(c, alice, async () => {
        for (const fn of ["report_conversations_summary", "report_agents", "report_heatmap", "report_usage_totals"]) {
          await expect(c.query(`select * from public.${fn}($1, $2, $3)`, [orgA, FROM, TO]), fn).rejects.toThrow(/permission denied/);
        }
      });
    });
  });
});
