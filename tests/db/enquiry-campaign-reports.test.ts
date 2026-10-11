/**
 * Enquiry and campaign report SQL (20261010000600), against hand-computed fixtures in Asia/Dubai
 * (UTC+4) so day bucketing is exercised. Synthetic data only.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asServiceRole, asUser, connect, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("enquiry + campaign reports", () => {
  let c: Client;
  let alice: string;
  let dana: string;
  let orgA: string;
  let team: string;
  const FROM = "2026-03-10";
  const TO = "2026-03-12";

  const one = async (sql: string, params: unknown[]) => (await c.query(sql, params)).rows[0].id as string;
  const rows = async <T,>(sql: string, params: unknown[]) => (await c.query(sql, params)).rows as T[];

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    dana = await createAuthUser(c, "dana@example.test");
    const bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    const orgB = await createOrg(c, "Org B", "org-b", bob);

    await asServiceRole(c, async () => {
      const admin = await one("select id from public.roles where org_id = $1 and name = 'Admin'", [orgA]);
      await c.query("insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)", [orgA, dana, admin]);
      team = await one("insert into public.teams (org_id, name) values ($1, 'Desk') returning id", [orgA]);
      await c.query("insert into public.team_members (org_id, team_id, user_id) values ($1, $2, $3)", [orgA, team, dana]);

      const pipeline = await one("insert into public.pipelines (org_id, name, is_default) values ($1, 'Main', true) returning id", [orgA]);
      const stage = async (name: string, sort: number) =>
        one("insert into public.stages (org_id, pipeline_id, name, sort) values ($1, $2, $3, $4) returning id", [orgA, pipeline, name, sort]);
      const sNew = await stage("New", 0);
      const sContacted = await stage("Contacted", 1);
      const sBooked = await stage("Booked", 2);

      const enquiry = (title: string, stageId: string, assignee: string, createdAt: string, status: string, closedAt: string | null) =>
        one(
          `insert into public.enquiries (org_id, pipeline_id, stage_id, title, assignee_id, created_at, status, closed_at, lost_reason)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
          [orgA, pipeline, stageId, title, assignee, createdAt, status, closedAt, status === "lost" || status === "disqualified" ? "no reason given" : null],
        );
      const event = (enq: string, type: string, payload: object, at: string) =>
        c.query("insert into public.timeline_events (org_id, enquiry_id, type, payload, at) values ($1, $2, $3, $4, $5)", [orgA, enq, type, JSON.stringify(payload), at]);

      // E1: created 11 Mar 00:30 Dubai, New -> Contacted -> Booked, won on 12 Mar
      const e1 = await enquiry("E1", sBooked, alice, "2026-03-10T20:30:00Z", "won", "2026-03-12T07:00:00Z");
      await event(e1, "enquiry.created", { stage_id: sNew }, "2026-03-10T20:30:00Z");
      await event(e1, "enquiry.stage_changed", { from_stage_id: sNew, to_stage_id: sContacted }, "2026-03-11T08:00:00Z");
      await event(e1, "enquiry.stage_changed", { from_stage_id: sContacted, to_stage_id: sBooked }, "2026-03-11T10:00:00Z");
      // E2: assigned to a team member, lost on 12 Mar from Contacted
      const e2 = await enquiry("E2", sContacted, dana, "2026-03-11T06:00:00Z", "lost", "2026-03-12T05:00:00Z");
      await event(e2, "enquiry.created", { stage_id: sNew }, "2026-03-11T06:00:00Z");
      await event(e2, "enquiry.stage_changed", { from_stage_id: sNew, to_stage_id: sContacted }, "2026-03-11T07:00:00Z");
      // E3: still open in New
      const e3 = await enquiry("E3", sNew, alice, "2026-03-12T05:00:00Z", "open", null);
      await event(e3, "enquiry.created", { stage_id: sNew }, "2026-03-12T05:00:00Z");
      // E4: created before the period, no timeline, disqualified on 11 Mar
      await enquiry("E4", sNew, alice, "2026-03-01T05:00:00Z", "disqualified", "2026-03-11T05:00:00Z");
      // another org's enquiry must never appear
      const pB = await one("insert into public.pipelines (org_id, name, is_default) values ($1, 'Other', true) returning id", [orgB]);
      const sB = await one("insert into public.stages (org_id, pipeline_id, name) values ($1, $2, 'B stage') returning id", [orgB, pB]);
      await c.query("insert into public.enquiries (org_id, pipeline_id, stage_id, title, created_at) values ($1, $2, $3, 'B', $4)", [orgB, pB, sB, "2026-03-11T06:00:00Z"]);

      // campaigns
      const channel = await one("insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'A', 'waba-a', 'pn-a') returning id", [orgA]);
      const template = await one(
        "insert into public.wa_templates (org_id, channel_id, waba_id, name, language, status, category) values ($1, $2, 'waba-a', 'promo', 'en', 'APPROVED', 'MARKETING') returning id",
        [orgA, channel],
      );
      const campaign = (name: string, status: string, startedAt: string | null) =>
        one(
          "insert into public.campaigns (org_id, name, channel_id, template_id, audience_type, status, started_at) values ($1, $2, $3, $4, 'csv', $5, $6) returning id",
          [orgA, name, channel, template, status, startedAt],
        );
      const spring = await campaign("Spring", "completed", "2026-03-11T06:00:00Z");
      await campaign("Draft", "preparing", null);
      await campaign("Old", "completed", "2026-02-01T06:00:00Z");
      const states: Array<[string, boolean]> = [["read", true], ["delivered", false], ["failed", false], ["skipped", false]];
      for (const [i, [status, replied]] of states.entries()) {
        const contact = await one("insert into public.contacts (org_id, first_name, phone_e164) values ($1, $2, $3) returning id", [orgA, `P${i}`, `+9715000010${i}`]);
        await c.query(
          "insert into public.campaign_recipients (org_id, campaign_id, contact_id, status, replied_at) values ($1, $2, $3, $4, $5)",
          [orgA, spring, contact, status, replied ? "2026-03-11T09:00:00Z" : null],
        );
      }
    });
  });

  afterAll(async () => {
    await c.end();
  });

  const summary = (users: string[] | null, teams: string[] | null) =>
    rows<Record<string, number | string>>("select * from public.report_enquiries_summary($1, $2, $3, $4, $5)", [orgA, FROM, TO, users, teams]);

  it("summarises created, closed and open enquiries, honouring the closed-day and org boundaries", async () => {
    await asServiceRole(c, async () => {
      const [s] = await summary(null, null);
      expect(s).toMatchObject({ created: 3, open_now: 1, won: 1, lost: 1, disqualified: 1 });
      const [mine] = await summary([alice], null);
      expect(mine).toMatchObject({ created: 2, open_now: 1, won: 1, lost: 0, disqualified: 1 });
      const [viaTeam] = await summary(null, [team]);
      expect(viaTeam).toMatchObject({ created: 1, open_now: 0, won: 0, lost: 1, disqualified: 0 });
    });
  });

  it("buckets per day in the org timezone and fills empty days", async () => {
    await asServiceRole(c, async () => {
      const days = await rows<{ day: Date; created: number; won: number; lost: number; disqualified: number }>(
        "select * from public.report_enquiries_by_day($1, $2, $3)", [orgA, FROM, TO]);
      expect(days.map((d) => [d.created, d.won, d.lost, d.disqualified])).toEqual([
        [0, 0, 0, 0], // 10 March: E1 was created 20:30 UTC = 11 March in Dubai
        [2, 0, 0, 1],
        [1, 1, 1, 0],
      ]);
    });
  });

  it("builds the funnel from the timeline: entries, current open, and where enquiries ended", async () => {
    await asServiceRole(c, async () => {
      const f = await rows<{ stage_name: string; entered: number; open_now: number; won_here: number; lost_here: number; disqualified_here: number }>(
        "select * from public.report_enquiry_funnel($1, $2, $3)", [orgA, FROM, TO]);
      const by = Object.fromEntries(f.map((r) => [r.stage_name, r]));
      expect(by.New).toMatchObject({ entered: 3, open_now: 1, disqualified_here: 1 });
      expect(by.Contacted).toMatchObject({ entered: 2, lost_here: 1 });
      expect(by.Booked).toMatchObject({ entered: 1, won_here: 1 });
      expect(f.map((r) => r.stage_name)).toEqual(["New", "Contacted", "Booked"]); // pipeline order
    });
  });

  it("measures time in stage from entry to next entry (or close), skipping the current open stay", async () => {
    await asServiceRole(c, async () => {
      const t = await rows<{ stage_name: string; stays: number; avg_seconds: string; median_seconds: number }>(
        "select * from public.report_enquiry_stage_times($1, $2, $3)", [orgA, FROM, TO]);
      const by = Object.fromEntries(t.map((r) => [r.stage_name, r]));
      expect(by.New).toMatchObject({ stays: 2 });
      expect(Number(by.New.avg_seconds)).toBe(22500); // (11.5h + 1h) / 2
      expect(Number(by.Contacted.avg_seconds)).toBe(43200); // (2h + 22h) / 2
      expect(Number(by.Booked.avg_seconds)).toBe(75600); // 21h, ended by closing the enquiry
      const team1 = await rows<{ stage_name: string; stays: number; avg_seconds: string }>(
        "select * from public.report_enquiry_stage_times($1, $2, $3, null, $4)", [orgA, FROM, TO, [team]]);
      expect(team1.map((r) => [r.stage_name, r.stays, Number(r.avg_seconds)])).toEqual([["New", 1, 3600], ["Contacted", 1, 79200]]);
    });
  });

  it("reports campaign funnels for campaigns in the period only, never drafts or other periods", async () => {
    await asServiceRole(c, async () => {
      const r = await rows<Record<string, number | string>>("select * from public.report_campaigns($1, $2, $3)", [orgA, FROM, TO]);
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ name: "Spring", total: 4, eligible: 3, sent: 2, delivered: 2, read_count: 1, replied: 1, failed: 1, skipped: 1 });
    });
  });

  it("keeps views and functions away from signed-in users", async () => {
    await asUser(c, alice, async () => {
      await expect(c.query("select * from public.v_enquiry_facts")).rejects.toThrow(/permission denied/);
    });
    await asUser(c, alice, async () => {
      await expect(c.query("select * from public.report_campaigns($1, $2, $3)", [orgA, FROM, TO])).rejects.toThrow(/permission denied/);
    });
  });
});
