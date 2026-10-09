/**
 * Campaign engine against a real database through PostgREST: fanout, consent
 * re-check, auto-pause, completion, retry rounds, the outbound guard and cancel.
 * Runs only when TEST_POSTGREST_URL and TEST_SERVICE_JWT are set (see supabase/test/README.md).
 * Fake data only.
 */
import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

import { connect, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;

const log = { info() {}, warn() {}, error() {} };

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)(
  "campaign engine (db)",
  () => {
    let c: Client;
    let admin: AdminClient;
    let org: string;
    let user: string;
    let channel: string;
    let template: string;
    let engine: typeof import("@/lib/campaigns/engine");
    let n = 0;

    async function q<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const { rows } = await c.query<T>(sql, params);
      return rows;
    }
    async function make(opts: {
      contacts: Array<{ first?: string; stop?: boolean; optIn?: boolean }>;
      status?: string;
      retryRounds?: number;
      guardrails?: Record<string, unknown>;
      category?: string;
    }) {
      await c.query("update public.wa_templates set category = $2 where id = $1", [
        template,
        opts.category ?? "UTILITY",
      ]);
      const { rows } = await c.query<{ id: string }>(
        "insert into public.campaigns (org_id, name, channel_id, template_id, audience_type, status, started_at, guard_since, quality_at_start, variable_map, retry_rounds, retry_delay_minutes, guardrails, created_by) values ($1, $2, $3, $4, 'csv', $5, now(), now(), 'GREEN', '{\"body.1\":\"contact.first_name\"}', $6, 5, $7, $8) returning id",
        [
          org,
          `camp ${++n}`,
          channel,
          template,
          opts.status ?? "sending",
          opts.retryRounds ?? 0,
          JSON.stringify(opts.guardrails ?? {}),
          user,
        ],
      );
      const campaign = rows[0].id;
      const recipients: string[] = [];
      for (const [i, k] of opts.contacts.entries()) {
        const contact = (
          await c.query<{ id: string }>(
            "insert into public.contacts (org_id, first_name, phone_e164, promotions_opt_in, stop_marketing) values ($1, $2, $3, $4, $5) returning id",
            [
              org,
              k.first ?? "",
              `+9715${String(n).padStart(2, "0")}${String(i).padStart(5, "0")}`,
              k.optIn ?? true,
              k.stop ?? false,
            ],
          )
        ).rows[0].id;
        recipients.push(
          (
            await c.query<{ id: string }>(
              "insert into public.campaign_recipients (org_id, campaign_id, contact_id) values ($1, $2, $3) returning id",
              [org, campaign, contact],
            )
          ).rows[0].id,
        );
      }
      return { campaign, recipients };
    }
    async function status(recipient: string) {
      return (
        await q<{ status: string; skip_reason: string | null; message_id: string | null }>(
          "select status, skip_reason, message_id from public.campaign_recipients where id = $1",
          [recipient],
        )
      )[0];
    }
    async function campaignRow(id: string) {
      return (
        await q<{
          status: string;
          paused_reason: string | null;
          retry_round: number;
          next_retry_at: string | null;
        }>(
          "select status, paused_reason, retry_round, next_retry_at from public.campaigns where id = $1",
          [id],
        )
      )[0];
    }
    const outboundDepth = async () =>
      Number((await q<{ n: string }>("select count(*)::text as n from pgmq.q_outbound"))[0].n);

    beforeAll(async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = POSTGREST_URL;
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
      process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
      process.env.JOB_SECRET = "test-job-secret-0123456789";
      engine = await import("@/lib/campaigns/engine");

      c = await connect();
      await resetDb(c);
      user = await createAuthUser(c, "marketer@example.test");
      org = await createOrg(c, "Org E", "org-e", user);
      admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
        auth: { persistSession: false },
      });
      await c.query("set role service_role");
      channel = (
        await c.query<{ id: string }>(
          "insert into public.channels (org_id, name, waba_id, phone_number_id, quality_rating) values ($1, 'Main', 'waba-e', 'pn-e', 'GREEN') returning id",
          [org],
        )
      ).rows[0].id;
      template = (
        await c.query<{ id: string }>(
          `insert into public.wa_templates (org_id, channel_id, waba_id, name, language, status, category, components)
         values ($1, $2, 'waba-e', 'reminder', 'en', 'APPROVED', 'UTILITY',
                 '[{"type":"BODY","text":"Hi {{1}}, see you soon.","example":{"body_text":[["Sam"]]}}]'::jsonb) returning id`,
          [org, channel],
        )
      ).rows[0].id;
      await c.query("reset role");
    });

    afterAll(async () => {
      await c?.end();
    });

    it("fans out pending recipients once, with resolved values and queued outbound jobs", async () => {
      const { campaign, recipients } = await make({
        contacts: [{ first: "Amina" }, { first: "Bo" }, { first: "Cy" }],
      });
      const before = await outboundDepth();
      const r = await engine.runFanout(admin, campaign, log);
      expect(r).toMatchObject({ dispatched: 3, skipped: 0, state: "drained" });
      expect(await outboundDepth()).toBe(before + 3);
      const rows = await q<{ body: string; status: string; kind: string }>(
        "select m.body, m.status, m.kind from public.messages m join public.campaign_recipients r on r.message_id = m.id where r.campaign_id = $1 order by m.body",
        [campaign],
      );
      expect(rows.map((x) => x.body)).toEqual([
        "Hi Amina, see you soon.",
        "Hi Bo, see you soon.",
        "Hi Cy, see you soon.",
      ]);
      expect(rows.every((x) => x.status === "queued" && x.kind === "template")).toBe(true);
      expect((await status(recipients[0])).status).toBe("queued");

      const again = await engine.runFanout(admin, campaign, log);
      expect(again.dispatched).toBe(0);
      expect(await outboundDepth()).toBe(before + 3);
    });

    it("re-checks consent and variables right before sending", async () => {
      const { campaign, recipients } = await make({
        category: "MARKETING",
        contacts: [
          { first: "Ok" },
          { first: "Stopped", stop: true },
          { first: "NoOptIn", optIn: false },
          { first: "" },
        ],
      });
      const r = await engine.runFanout(admin, campaign, log);
      expect(r.dispatched).toBe(1);
      expect(r.skipped).toBe(3);
      expect((await status(recipients[1])).skip_reason).toBe("stop_marketing");
      expect((await status(recipients[2])).skip_reason).toBe("no_opt_in");
      expect((await status(recipients[3])).skip_reason).toBe("missing_variable:body.1");
    });

    it("does nothing for a campaign that is not sending", async () => {
      const { campaign, recipients } = await make({ status: "paused", contacts: [{ first: "A" }] });
      expect((await engine.runFanout(admin, campaign, log)).state).toBe("paused");
      expect((await status(recipients[0])).status).toBe("pending");
    });

    it("auto-pauses on a failure spike and notifies the team", async () => {
      const { campaign, recipients } = await make({
        contacts: Array.from({ length: 10 }, (_, i) => ({ first: `P${i}` })),
        guardrails: { min_sample: 5, max_failure_pct: 20 },
      });
      // 6 failed with a transient Meta error, 4 sent: 60% systemic failures.
      for (const [i, id] of recipients.entries()) {
        if (i < 6)
          await c.query(
            "update public.campaign_recipients set status = 'failed', error_code = 131000, failed_at = now() where id = $1",
            [id],
          );
        else
          await c.query(
            "update public.campaign_recipients set status = 'sent', sent_at = now() where id = $1",
            [id],
          );
      }
      const r = await engine.runFanout(admin, campaign, log);
      expect(r.state).toBe("paused");
      const row = await campaignRow(campaign);
      expect(row.status).toBe("paused");
      expect(row.paused_reason).toMatch(/failed/);
      const notes = await q(
        "select 1 from public.notifications where type = 'campaign.paused' and user_id = $1",
        [user],
      );
      expect(notes.length).toBeGreaterThan(0);
    });

    it("pauses when the number's quality drops below where it started", async () => {
      const { campaign } = await make({ contacts: [{ first: "A" }] });
      await c.query("update public.channels set quality_rating = 'YELLOW' where id = $1", [
        channel,
      ]);
      try {
        const r = await engine.refreshCampaign(admin, campaign, log);
        expect(r.status).toBe("paused");
        expect((await campaignRow(campaign)).paused_reason).toMatch(/quality/i);
      } finally {
        await c.query("update public.channels set quality_rating = 'GREEN' where id = $1", [
          channel,
        ]);
      }
    });

    it("completes when nothing is left, and refreshes the stored funnel", async () => {
      const { campaign, recipients } = await make({ contacts: [{ first: "A" }, { first: "B" }] });
      await c.query(
        "update public.campaign_recipients set status = 'read', sent_at = now(), delivered_at = now(), read_at = now() where id = $1",
        [recipients[0]],
      );
      await c.query(
        "update public.campaign_recipients set status = 'failed', error_code = 131026, failed_at = now() where id = $1",
        [recipients[1]],
      );
      await engine.refreshCampaign(admin, campaign, log);
      expect((await campaignRow(campaign)).status).toBe("completed");
      const stats = (
        await q<{ stats: { sent: number; read: number; failed: number } }>(
          "select stats from public.campaigns where id = $1",
          [campaign],
        )
      )[0].stats;
      expect(stats).toMatchObject({ sent: 1, read: 1, failed: 1 });
    });

    it("schedules a retry round for temporary failures, then re-queues exactly those", async () => {
      const { campaign, recipients } = await make({
        retryRounds: 1,
        contacts: [{ first: "A" }, { first: "B" }, { first: "C" }],
        guardrails: { min_sample: 100 },
      });
      await c.query(
        "update public.campaign_recipients set status = 'sent', sent_at = now() where id = $1",
        [recipients[0]],
      );
      await c.query(
        "update public.campaign_recipients set status = 'failed', error_code = 130429, failed_at = now() where id = $1",
        [recipients[1]],
      );
      await c.query(
        "update public.campaign_recipients set status = 'failed', error_code = 131026, failed_at = now() where id = $1",
        [recipients[2]],
      );

      await engine.refreshCampaign(admin, campaign, log);
      let row = await campaignRow(campaign);
      expect(row.status).toBe("sending");
      expect(row.next_retry_at).not.toBeNull();
      const jobs = await q(
        "select 1 from public.scheduled_jobs where dedupe_key = $1 and done_at is null",
        [`campaign:retry:${campaign}:1`],
      );
      expect(jobs).toHaveLength(1);

      // The scheduler fires it later; a wrong round is ignored, the right one re-queues.
      expect(await engine.runRetryRound(admin, campaign, 2, log)).toBe(false);
      expect(await engine.runRetryRound(admin, campaign, 1, log)).toBe(true);
      row = await campaignRow(campaign);
      expect(row.retry_round).toBe(1);
      expect(row.next_retry_at).toBeNull();
      expect((await status(recipients[1])).status).toBe("pending");
      expect((await status(recipients[2])).status).toBe("failed"); // not retryable
      expect(await engine.runRetryRound(admin, campaign, 1, log)).toBe(false); // idempotent

      await engine.runFanout(admin, campaign, log);
      expect((await status(recipients[1])).status).toBe("queued");
      // After the last round the campaign completes even though one failure remains.
      await c.query(
        "update public.campaign_recipients set status = 'sent', sent_at = now() where id = $1",
        [recipients[1]],
      );
      await engine.refreshCampaign(admin, campaign, log);
      expect((await campaignRow(campaign)).status).toBe("completed");
    });

    it("the outbound guard withdraws messages of paused/cancelled campaigns and opted-out contacts", async () => {
      const { campaign } = await make({
        contacts: [{ first: "A" }, { first: "B" }, { first: "C" }],
      });
      await engine.runFanout(admin, campaign, log);
      const msgs = await q<{ id: string; recipient: string; contact: string }>(
        "select m.id, r.id as recipient, r.contact_id as contact from public.messages m join public.campaign_recipients r on r.message_id = m.id where r.campaign_id = $1 order by r.created_at, r.id",
        [campaign],
      );
      expect(msgs).toHaveLength(3);

      // sending + utility: goes ahead
      expect(
        await engine.guardCampaignMessage(admin, msgs[0].id, msgs[0].recipient, {
          stop_marketing: false,
        }),
      ).toBe("send");

      await c.query("update public.campaigns set status = 'paused' where id = $1", [campaign]);
      expect(
        await engine.guardCampaignMessage(admin, msgs[0].id, msgs[0].recipient, {
          stop_marketing: false,
        }),
      ).toBe("released");
      expect((await status(msgs[0].recipient)).status).toBe("pending");
      expect(await q("select 1 from public.messages where id = $1", [msgs[0].id])).toHaveLength(0);

      await c.query("update public.campaigns set status = 'cancelled' where id = $1", [campaign]);
      expect(
        await engine.guardCampaignMessage(admin, msgs[1].id, msgs[1].recipient, {
          stop_marketing: false,
        }),
      ).toBe("released");
      expect(await status(msgs[1].recipient)).toMatchObject({
        status: "skipped",
        skip_reason: "cancelled",
      });

      await c.query("update public.campaigns set status = 'sending' where id = $1", [campaign]);
      await c.query("update public.wa_templates set category = 'MARKETING' where id = $1", [
        template,
      ]);
      expect(
        await engine.guardCampaignMessage(admin, msgs[2].id, msgs[2].recipient, {
          stop_marketing: true,
        }),
      ).toBe("released");
      expect((await status(msgs[2].recipient)).skip_reason).toBe("stop_marketing");
      await c.query("update public.wa_templates set category = 'UTILITY' where id = $1", [
        template,
      ]);
    });

    it("cancel closes pending recipients and is a no-op the second time", async () => {
      const { campaign, recipients } = await make({ contacts: [{ first: "A" }, { first: "B" }] });
      expect(await engine.cancelCampaign(admin, campaign)).toBe(true);
      expect((await campaignRow(campaign)).status).toBe("cancelled");
      expect(await status(recipients[0])).toMatchObject({
        status: "skipped",
        skip_reason: "cancelled",
      });
      expect(await engine.cancelCampaign(admin, campaign)).toBe(false);
    });

    it("start and resume are idempotent state transitions", async () => {
      const { campaign } = await make({ status: "queued", contacts: [{ first: "A" }] });
      expect(await engine.startCampaign(admin, campaign)).toBe(true);
      expect(await engine.startCampaign(admin, campaign)).toBe(false);
      expect(await engine.resumeCampaign(admin, campaign)).toBe(false); // not paused
      await engine.pauseCampaign(
        admin,
        { id: campaign, org_id: org, name: "x", created_by: user },
        "manual",
      );
      expect(await engine.resumeCampaign(admin, campaign)).toBe(true);
      expect((await campaignRow(campaign)).status).toBe("sending");
    });
  },
);
