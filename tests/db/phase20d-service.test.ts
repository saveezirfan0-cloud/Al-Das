/**
 * Phase 20d server code against a real Postgres through PostgREST: a recurring campaign's runs (audience re-read,
 * one campaign per run, guardrails), the budget stop inside the fanout, retry-on-fail, the TTL guard in the outbound
 * job, the per-template SMS fallback switch and the close-with-enquiry audit trail. Nothing reaches Meta or an SMS
 * provider (tests/setup.ts blocks them; the TTL path returns before any client is built). Synthetic data only.
 * Runs only with TEST_DATABASE_URL, TEST_POSTGREST_URL and TEST_SERVICE_JWT (supabase/test/README.md).
 */
import { randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { BUDGET_PAUSE_REASON } from "@/lib/campaigns/budget";
import { runFanout } from "@/lib/campaigns/engine";
import { runRecurrence } from "@/lib/campaigns/recurring";
import { closeWithEnquiry } from "@/lib/inbox/close";
import { saveSettings, setEnabled } from "@/lib/integrations/accounts";
import { queueSmsFallback } from "@/lib/integrations/sms/fallback";
import { deliverOutbound } from "@/lib/jobs/handlers/outbound";
import type { JobContext } from "@/lib/jobs/types";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";
import { TEMPLATE_RETRY_DELAYS_SECONDS, TTL_EXPIRED_CODE } from "@/lib/templates/delivery";
import { maybeRetryTemplateMessage } from "@/lib/templates/retry";

import {
  asServiceRole,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;
const log = { info() {}, warn() {}, error() {} };

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)(
  "phase 20d services (db)",
  () => {
    let c: Client;
    let admin: AdminClient;
    let org: string;
    let alice: string;
    let channel: string;
    let template: string;
    let n = 0;
    const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await asServiceRole(c, () => c.query<T>(sql, params))).rows;
    const one = async (sql: string, params: unknown[] = []) =>
      (await q<{ id: string }>(sql + " returning id::text as id", params))[0]!.id;
    const phone = () => `+447700900${String(700 + ++n).padStart(3, "0")}`;
    const contact = (first: string, extra = "") =>
      one(
        `insert into public.contacts (org_id, first_name, last_name, phone_e164, promotions_opt_in) values ($1, $2, 'Demo${extra}', $3, true)`,
        [org, first, phone()],
      );
    const conversation = (contactId: string) =>
      one("insert into public.conversations (org_id, channel_id, contact_id) values ($1, $2, $3)", [
        org,
        channel,
        contactId,
      ]);
    const templateMessage = (
      conv: string,
      tpl: string,
      over: { status?: string; code?: number | null; at?: string } = {},
    ) =>
      one(
        `insert into public.messages (org_id, conversation_id, direction, kind, body, payload, status, error_code, at)
       values ($1, $2, 'out', 'template', 'Hello', jsonb_build_object('send', jsonb_build_object('type', 'template', 'template_id', $3::text, 'values', jsonb_build_object('body.1', 'Layla'))), $4, $5, coalesce($6::timestamptz, now()))`,
        [org, conv, tpl, over.status ?? "failed", over.code ?? null, over.at ?? null],
      );

    beforeAll(async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = POSTGREST_URL;
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
      process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
      process.env.JOB_SECRET = "test-job-secret-0123456789";
      process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
      process.env.APP_URL = "https://pulse.test";
      c = await connect();
      await resetDb(c);
      alice = await createAuthUser(c, "alice-20ds@example.test");
      org = await createOrg(c, "Org 20d S", "org-20d-s", alice);
      admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
        auth: { persistSession: false },
      }) as AdminClient;
      await q("update public.orgs set timezone = 'Asia/Dubai' where id = $1", [org]);
      channel = await one(
        "insert into public.channels (org_id, name, waba_id, phone_number_id, quality_rating) values ($1, 'Main', 'waba-20ds', 'pn-20ds', 'GREEN')",
        [org],
      );
      template = await one(
        `insert into public.wa_templates (org_id, channel_id, waba_id, name, language, status, category, components, variable_map)
       values ($1, $2, 'waba-20ds', 'checkup_20d', 'en', 'APPROVED', 'UTILITY', '[{"type":"BODY","text":"Hello {{1}}"}]', '{"body.1":"contact.first_name"}')`,
        [org, channel],
      );
    });
    afterAll(async () => {
      await resetDb(c);
      await c.end();
    });

    // -----------------------------------------------------------------------------------------------------------------
    describe("recurring campaign runs", () => {
      let segment: string;
      let rec: string;
      const R1 = "2026-10-26T06:00:00.000Z";
      const campaigns = () =>
        q<{ id: string; status: string; run_key: string }>(
          "select id::text, status, run_key from public.campaigns where recurrence_id = $1 order by created_at",
          [rec],
        );
      const recipientCount = async (campaignId: string) =>
        Number(
          (
            await q<{ n: string }>(
              "select count(*)::text as n from public.campaign_recipients where campaign_id = $1 and status = 'pending'",
              [campaignId],
            )
          )[0]!.n,
        );
      const nextRunAt = async () =>
        (
          await q<{ next_run_at: Date }>(
            "select next_run_at from public.campaign_recurrences where id = $1",
            [rec],
          )
        )[0]!.next_run_at.toISOString();

      beforeAll(async () => {
        segment = await one(
          "insert into public.segments (org_id, name, kind) values ($1, 'Check-up due', 'static')",
          [org],
        );
        for (const name of ["Layla Demo-11", "Omar Demo-12"]) {
          const k = await contact(name);
          await q(
            "insert into public.segment_members (org_id, segment_id, contact_id) values ($1, $2, $3)",
            [org, segment, k],
          );
        }
        rec = await one(
          `insert into public.campaign_recurrences (org_id, name, channel_id, template_id, segment_id, cron, timezone, next_run_at, created_by)
         values ($1, 'Weekly check-up', $2, $3, $4, '0 10 * * 1', 'Asia/Dubai', $5, $6)`,
          [org, channel, template, segment, R1, alice],
        );
      });

      it("creates the run's campaign, builds its audience now, starts it and schedules the next run", async () => {
        const r = await runRecurrence(admin, rec, R1, log);
        expect(r.outcome).toBe("started");
        const list = await campaigns();
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ status: "queued", run_key: "2026-10-26T06:00Z" });
        expect(await recipientCount(list[0]!.id)).toBe(2);
        const next = await nextRunAt();
        expect(new Date(next).getTime()).toBeGreaterThan(Date.now());
        const jobs = await q<{ n: string }>(
          "select count(*)::text as n from public.scheduled_jobs where kind = 'campaign.recurrence' and dedupe_key = $1",
          [`campaign:recur:${rec}:${next}`],
        );
        expect(jobs[0]!.n).toBe("1");
      });

      it("does nothing when the same run is delivered again", async () => {
        expect((await runRecurrence(admin, rec, R1, log)).outcome).toBe("stale");
        expect(await campaigns()).toHaveLength(1);
      });

      it("re-reads the segment on the next run", async () => {
        const k = await contact("Sara Demo-13");
        await q(
          "insert into public.segment_members (org_id, segment_id, contact_id) values ($1, $2, $3)",
          [org, segment, k],
        );
        await q("update public.campaigns set status = 'completed' where recurrence_id = $1", [rec]);
        const r = await runRecurrence(admin, rec, await nextRunAt(), log);
        expect(r.outcome).toBe("started");
        const list = await campaigns();
        expect(list).toHaveLength(2);
        expect(await recipientCount(list[1]!.id)).toBe(3);
      });

      it("skips a run while the previous one is still sending, and when the template is no longer approved", async () => {
        // Run 2 is still 'queued': the next run is skipped, quietly.
        expect(await runRecurrence(admin, rec, await nextRunAt(), log)).toEqual({
          outcome: "skipped",
          reason: "previous_run_active",
        });
        await q("update public.campaigns set status = 'completed' where recurrence_id = $1", [rec]);
        await q("update public.wa_templates set status = 'PAUSED' where id = $1", [template]);
        expect(await runRecurrence(admin, rec, await nextRunAt(), log)).toEqual({
          outcome: "skipped",
          reason: "template_not_approved",
        });
        await q("update public.wa_templates set status = 'APPROVED' where id = $1", [template]);
        expect(await campaigns()).toHaveLength(2);
        const notes = await q<{ title: string; body: string }>(
          "select title, body from public.notifications where org_id = $1 and type = 'campaign.recurrence_skipped'",
          [org],
        );
        expect(notes).toHaveLength(1); // only the template problem tells the owner
        expect(notes[0]!.body).toMatch(/not approved/);
        const [r] = await q<{ last_run_outcome: string; runs: number }>(
          "select last_run_outcome, runs from public.campaign_recurrences where id = $1",
          [rec],
        );
        expect(r).toMatchObject({ last_run_outcome: "skipped:template_not_approved", runs: 4 });
      });

      it("is not blocked by a paused previous run (a budget stop is never resumed by itself)", async () => {
        await q("update public.campaigns set status = 'paused' where recurrence_id = $1", [rec]);
        expect((await runRecurrence(admin, rec, await nextRunAt(), log)).outcome).toBe("started");
        expect(await campaigns()).toHaveLength(3);
      });

      it("ignores a paused series", async () => {
        await q("update public.campaign_recurrences set status = 'paused' where id = $1", [rec]);
        expect((await runRecurrence(admin, rec, await nextRunAt(), log)).outcome).toBe("inactive");
      });
    });

    // -----------------------------------------------------------------------------------------------------------------
    describe("monthly budget inside the fanout", () => {
      it("dispatches only what the budget allows, then pauses the campaign with the budget reason", async () => {
        await q("delete from public.campaign_budget_months where org_id = $1", [org]);
        await q(
          `update public.orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{campaign_budget}', '{"monthly_limit": 2}') where id = $1`,
          [org],
        );
        const campaign = await one(
          `insert into public.campaigns (org_id, name, channel_id, template_id, audience_type, status, started_at, guard_since, quality_at_start, variable_map, created_by)
         values ($1, 'Budget test', $2, $3, 'csv', 'sending', now(), now(), 'GREEN', '{"body.1":"contact.first_name"}', $4)`,
          [org, channel, template, alice],
        );
        for (const name of ["Huda Demo-21", "Ali Demo-22", "Mona Demo-23"]) {
          const k = await contact(name, "Budget");
          await q(
            "insert into public.campaign_recipients (org_id, campaign_id, contact_id) values ($1, $2, $3)",
            [org, campaign, k],
          );
        }
        const r = await runFanout(admin, campaign, log);
        expect(r).toMatchObject({ dispatched: 2, state: "budget_reached" });
        const [row] = await q<{ status: string; paused_reason: string }>(
          "select status, paused_reason from public.campaigns where id = $1",
          [campaign],
        );
        expect(row).toEqual({ status: "paused", paused_reason: BUDGET_PAUSE_REASON });
        const counts = await q<{ status: string; n: string }>(
          "select status, count(*)::text as n from public.campaign_recipients where campaign_id = $1 group by status order by status",
          [campaign],
        );
        expect(counts).toEqual([
          { status: "pending", n: "1" },
          { status: "queued", n: "2" },
        ]);
        const [b] = await q<{ used: number; monthly_limit: number }>(
          "select used, monthly_limit from public.campaign_budget_status($1)",
          [org],
        );
        expect(b).toEqual({ used: 2, monthly_limit: 2 });
        await q(`update public.orgs set settings = settings - 'campaign_budget' where id = $1`, [
          org,
        ]);
      });
    });

    // -----------------------------------------------------------------------------------------------------------------
    describe("retry on fail", () => {
      let retryTemplate: string;
      let conv: string;
      beforeAll(async () => {
        retryTemplate = await one(
          `insert into public.wa_templates (org_id, channel_id, waba_id, name, language, status, category, components, retry_on_fail)
         values ($1, $2, 'waba-20ds', 'retry_20d', 'en', 'APPROVED', 'UTILITY', '[{"type":"BODY","text":"Hello {{1}}"}]', true)`,
          [org, channel],
        );
        conv = await conversation(await contact("Rami Demo-31"));
      });

      it("queues one delayed copy of a failed message, and only one however often it is asked", async () => {
        const failed = await templateMessage(conv, retryTemplate, { code: 131000 });
        const first = await maybeRetryTemplateMessage(admin, org, failed);
        expect(first.status).toBe("queued");
        const again = await maybeRetryTemplateMessage(admin, org, failed);
        expect(again).toEqual({
          status: "exists",
          retryMessageId: (first as { retryMessageId: string }).retryMessageId,
        });
        const copies = await q<{
          status: string;
          retry_of: string;
          payload: { retry: { attempt: number } };
        }>(
          "select status, retry_of_message_id::text as retry_of, payload from public.messages where retry_of_message_id = $1",
          [failed],
        );
        expect(copies).toHaveLength(1);
        expect(copies[0]).toMatchObject({
          status: "queued",
          retry_of: failed,
          payload: { retry: { attempt: 1 } },
        });
        // Held back in the queue for the first delay (pgmq visibility time in the future).
        const [m] = (
          await c.query<{ wait: number }>(
            "select extract(epoch from (vt - now()))::int as wait from pgmq.q_outbound where message ->> 'message_id' = $1",
            [(first as { retryMessageId: string }).retryMessageId],
          )
        ).rows;
        expect(m!.wait).toBeGreaterThan(TEMPLATE_RETRY_DELAYS_SECONDS[0] - 30);
      });

      it("follows the chain to the limit, then stops", async () => {
        const failed = await templateMessage(conv, retryTemplate, { code: 130429 });
        const r1 = (await maybeRetryTemplateMessage(admin, org, failed)) as {
          retryMessageId: string;
        };
        await q("update public.messages set status = 'failed', error_code = 131000 where id = $1", [
          r1.retryMessageId,
        ]);
        const r2 = (await maybeRetryTemplateMessage(admin, org, r1.retryMessageId)) as {
          status: string;
          retryMessageId: string;
        };
        expect(r2.status).toBe("queued");
        await q("update public.messages set status = 'failed', error_code = 131000 where id = $1", [
          r2.retryMessageId,
        ]);
        expect(await maybeRetryTemplateMessage(admin, org, r2.retryMessageId)).toEqual({
          status: "skipped",
          reason: "exhausted",
        });
      });

      it("never retries a permanent error, a template with the switch off or a message that did not fail", async () => {
        expect(
          await maybeRetryTemplateMessage(
            admin,
            org,
            await templateMessage(conv, retryTemplate, { code: 131026 }),
          ),
        ).toEqual({
          status: "skipped",
          reason: "not_retryable",
        });
        expect(
          await maybeRetryTemplateMessage(
            admin,
            org,
            await templateMessage(conv, template, { code: 131000 }),
          ),
        ).toEqual({
          status: "skipped",
          reason: "off",
        });
        expect(
          await maybeRetryTemplateMessage(
            admin,
            org,
            await templateMessage(conv, retryTemplate, { status: "delivered" }),
          ),
        ).toEqual({ status: "skipped", reason: "not_failed" });
      });
    });

    // -----------------------------------------------------------------------------------------------------------------
    describe("message TTL in the outbound job", () => {
      it("fails a template message that waited longer than its template's limit, before any send", async () => {
        const ttlTemplate = await one(
          `insert into public.wa_templates (org_id, channel_id, waba_id, name, language, status, category, components, ttl_seconds)
         values ($1, $2, 'waba-20ds', 'ttl_20d', 'en', 'APPROVED', 'UTILITY', '[{"type":"BODY","text":"Hello {{1}}"}]', 600)`,
          [org, channel],
        );
        const conv = await conversation(await contact("Nour Demo-41"));
        const old = await templateMessage(conv, ttlTemplate, {
          status: "queued",
          at: new Date(Date.now() - 3600_000).toISOString(),
        });
        const ctx = {
          queue: "outbound_priority",
          msgId: 1,
          readCt: 1,
          enqueuedAt: new Date(),
          admin,
          log,
        } as unknown as JobContext;
        await deliverOutbound(admin, old, ctx);
        const [m] = await q<{ status: string; error_code: number; wa_message_id: string | null }>(
          "select status, error_code, wa_message_id from public.messages where id = $1",
          [old],
        );
        expect(m).toEqual({ status: "failed", error_code: TTL_EXPIRED_CODE, wa_message_id: null });
      });
    });

    // -----------------------------------------------------------------------------------------------------------------
    describe("SMS fallback switch per template", () => {
      it("skips the fallback for a template that has it off or is marketing, and queues it otherwise", async () => {
        await saveSettings(admin, {
          orgId: org,
          kind: "sms",
          provider: "twilio",
          secrets: { auth_token: "tok_secret_value" },
          config: {
            account_sid: "AC00000000000000000000000000000000",
            sender: "ALDAS",
            clinic_name: "Al Das Clinic",
            callback_phone: "+97140000000",
            rate_per_sec: 1000,
            daily_cap: 200,
            segment_price: "0.20",
          },
        });
        await setEnabled(admin, { orgId: org, kind: "sms", userId: alice, enabled: true });
        const loc = await one(
          "insert into public.locations (org_id, name) values ($1, 'Demo Clinic')",
          [org],
        );
        const spec = await one(
          "insert into public.specialists (org_id, name) values ($1, 'Dr Demo')",
          [org],
        );
        const patient = await one(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Layla Demo-51', 'Sms', '+971501110051')",
          [org],
        );
        const appt = await one(
          "insert into public.appointments (org_id, contact_id, location_id, specialist_id, starts_at, ends_at, status) values ($1, $2, $3, $4, now() + interval '2 days', now() + interval '2 days 30 minutes', 'confirmed')",
          [org, patient, loc, spec],
        );
        const conv = await conversation(patient);
        const reminderTpl = await one(
          `insert into public.wa_templates (org_id, channel_id, waba_id, name, language, status, category, sms_fallback)
         values ($1, $2, 'waba-20ds', 'reminder_sms_20d', 'en', 'APPROVED', 'UTILITY', false)`,
          [org, channel],
        );
        const promoTpl = await one(
          `insert into public.wa_templates (org_id, channel_id, waba_id, name, language, status, category, sms_fallback)
         values ($1, $2, 'waba-20ds', 'promo_sms_20d', 'en', 'APPROVED', 'MARKETING', true)`,
          [org, channel],
        );
        const viaReminder = await templateMessage(conv, reminderTpl, { code: 131026 });
        const viaPromo = await templateMessage(conv, promoTpl, { code: 131026 });
        const call = (sourceMessageId: string) =>
          queueSmsFallback(admin, {
            orgId: org,
            appointmentId: appt,
            reminderId: null,
            sourceMessageId,
            whatsappErrorCode: 131026,
          });

        expect(await call(viaReminder)).toBe("skipped:template_off");
        expect(await call(viaPromo)).toBe("skipped:template_off");
        await q("update public.wa_templates set sms_fallback = true where id = $1", [reminderTpl]);
        expect(await call(viaReminder)).toBe("queued");
      });
    });

    // -----------------------------------------------------------------------------------------------------------------
    describe("appointment reminder with retry on fail", () => {
      it("never re-sends a reminder (the visit may change during the delay): it fails at once with the call task", async () => {
        const loc = await one(
          "insert into public.locations (org_id, name) values ($1, 'Retry Clinic')",
          [org],
        );
        const spec = await one(
          "insert into public.specialists (org_id, name) values ($1, 'Dr Retry')",
          [org],
        );
        const patient = await contact("Huda Demo-71");
        const appt = await one(
          "insert into public.appointments (org_id, contact_id, location_id, specialist_id, starts_at, ends_at, status) values ($1, $2, $3, $4, now() + interval '3 days', now() + interval '3 days 30 minutes', 'confirmed')",
          [org, patient, loc, spec],
        );
        const tpl = await one(
          `insert into public.wa_templates (org_id, channel_id, waba_id, name, language, status, category, components, retry_on_fail)
           values ($1, $2, 'waba-20ds', 'reminder_retry_20d', 'en', 'APPROVED', 'UTILITY', '[{"type":"BODY","text":"Hello {{1}}"}]', true)`,
          [org, channel],
        );
        const conv = await conversation(patient);
        const failed = await templateMessage(conv, tpl, { code: 131000 });
        const reminder = await one(
          "insert into public.appointment_reminders (org_id, appointment_id, idx, due_at, status, message_id) values ($1, $2, 1, now(), 'sent', $3)",
          [org, appt, failed],
        );
        const { emit } = await import("@/lib/events/emit");
        await import("@/lib/jobs/handlers/appointments"); // registers the reminder listener
        const reminderStatus = async () =>
          (
            await q<{ status: string }>(
              "select status from public.appointment_reminders where id = $1",
              [reminder],
            )
          )[0]!.status;
        const callTasks = async () =>
          Number(
            (
              await q<{ n: string }>(
                "select count(*)::text as n from public.tasks where appointment_id = $1 and type = 'call'",
                [appt],
              )
            )[0]!.n,
          );

        await emit(org, "message.failed", { message_id: failed, code: 131000 });
        const copies = await q("select id from public.messages where retry_of_message_id = $1", [
          failed,
        ]);
        expect(copies).toHaveLength(0);
        expect(await reminderStatus()).toBe("failed");
        expect(await callTasks()).toBe(1);
        expect(await maybeRetryTemplateMessage(admin, org, failed)).toEqual({
          status: "skipped",
          reason: "appointment_message",
        });
      });
    });

    // -----------------------------------------------------------------------------------------------------------------
    describe("close with enquiry", () => {
      let pipeline: string;
      let s1: string;
      let s2: string;
      beforeAll(async () => {
        pipeline = await one(
          "insert into public.pipelines (org_id, name) values ($1, 'New patients')",
          [org],
        );
        s1 = await one(
          "insert into public.stages (org_id, pipeline_id, name, sort) values ($1, $2, 'New', 1)",
          [org, pipeline],
        );
        s2 = await one(
          "insert into public.stages (org_id, pipeline_id, name, sort) values ($1, $2, 'Booked', 2)",
          [org, pipeline],
        );
      });
      const audit = (entityId: string) =>
        q<{ action: string; diff: Record<string, unknown> }>(
          "select action, diff from public.audit_log where org_id = $1 and (entity_id = $2 or diff ->> 'enquiry_id' = $2::text) order by at, id",
          [org, entityId],
        );

      it("creates a lost enquiry and closes the conversation in one step, with the full audit trail", async () => {
        const k = await contact("Yara Demo-61");
        const convId = await conversation(k);
        const r = await closeWithEnquiry(
          admin,
          { orgId: org, userId: alice },
          { id: convId, contact_id: k, channel_id: channel },
          {
            category_id: null,
            summary: "Asked about prices for a cleaning",
            enquiry: {
              mode: "create",
              pipeline_id: pipeline,
              stage_id: null,
              title: "WhatsApp enquiry",
              status: "lost",
              reason: "Price",
              appt_date: "2026-11-02",
            },
          },
        );
        expect(r).toMatchObject({ ok: true, created: true });
        const enquiryId = (r as { enquiryId: string }).enquiryId;
        const [e] = await q<{
          contact_id: string;
          status: string;
          lost_reason: string;
          stage_id: string;
          appt_date: Date;
        }>(
          "select contact_id::text, status, lost_reason, stage_id::text, appt_date from public.enquiries where id = $1",
          [enquiryId],
        );
        expect(e).toMatchObject({
          contact_id: k,
          status: "lost",
          lost_reason: "Price",
          stage_id: s1,
        });
        expect(e!.appt_date.toISOString()).toBe("2026-11-02T00:00:00.000Z");
        const [conv] = await q<{ status: string; closed_by: string; summary: string }>(
          "select status, closed_by::text, summary from public.conversations where id = $1",
          [convId],
        );
        expect(conv).toEqual({
          status: "closed",
          closed_by: alice,
          summary: "Asked about prices for a cleaning",
        });

        const enquiryAudit = (await audit(enquiryId)).map((a) => a.action);
        expect(enquiryAudit).toEqual(
          expect.arrayContaining([
            "enquiry.created",
            "enquiry.status_changed",
            "conversation.closed_with_enquiry",
          ]),
        );
        const combined = (await audit(convId)).find(
          (a) => a.action === "conversation.closed_with_enquiry",
        )!;
        expect(combined.diff).toEqual({
          enquiry_id: enquiryId,
          enquiry_created: true,
          steps: ["created", "status:lost"],
          category_id: null,
          closed: true,
        });
        expect(JSON.stringify(combined.diff)).not.toContain("prices"); // the summary is health data: never in audit_log
        const timeline = await q<{ type: string }>(
          "select type from public.timeline_events where org_id = $1 and contact_id = $2 order by at",
          [org, k],
        );
        expect(timeline.map((t) => t.type)).toEqual(
          expect.arrayContaining([
            "enquiry.created",
            "enquiry.status_changed",
            "conversation.closed",
          ]),
        );
      });

      it("moves an open enquiry and marks it won", async () => {
        const k = await contact("Dana Demo-62");
        const convId = await conversation(k);
        const enquiry = await one(
          "insert into public.enquiries (org_id, pipeline_id, stage_id, title, contact_id) values ($1, $2, $3, 'Existing', $4)",
          [org, pipeline, s1, k],
        );
        const r = await closeWithEnquiry(
          admin,
          { orgId: org, userId: alice },
          { id: convId, contact_id: k, channel_id: channel },
          {
            category_id: null,
            summary: "",
            enquiry: { mode: "update", enquiry_id: enquiry, stage_id: s2, status: "won" },
          },
        );
        expect(r).toMatchObject({ ok: true, created: false, enquiryId: enquiry });
        expect((await audit(enquiry)).map((a) => a.action)).toEqual(
          expect.arrayContaining([
            "enquiry.stage_changed",
            "enquiry.status_changed",
            "conversation.closed_with_enquiry",
          ]),
        );
        const [e] = await q<{ stage_id: string; status: string }>(
          "select stage_id::text, status from public.enquiries where id = $1",
          [enquiry],
        );
        expect(e).toEqual({ stage_id: s2, status: "won" });
      });

      it("refuses another patient's enquiry or a missing reason and leaves the conversation open, unaudited", async () => {
        const k = await contact("Rana Demo-63");
        const other = await contact("Tala Demo-64");
        const convId = await conversation(k);
        const foreign = await one(
          "insert into public.enquiries (org_id, pipeline_id, stage_id, title, contact_id) values ($1, $2, $3, 'Not hers', $4)",
          [org, pipeline, s1, other],
        );
        const target = { id: convId, contact_id: k, channel_id: channel };
        const r1 = await closeWithEnquiry(admin, { orgId: org, userId: alice }, target, {
          category_id: null,
          summary: "",
          enquiry: { mode: "update", enquiry_id: foreign, status: "won" },
        });
        expect(r1).toEqual({ ok: false, error: expect.stringMatching(/another patient/) });
        const r2 = await closeWithEnquiry(admin, { orgId: org, userId: alice }, target, {
          category_id: null,
          summary: "",
          enquiry: {
            mode: "create",
            pipeline_id: pipeline,
            title: "t",
            status: "disqualified",
            reason: " ",
          },
        });
        expect(r2).toEqual({ ok: false, error: expect.stringMatching(/reason is required/) });
        const [conv] = await q<{ status: string }>(
          "select status from public.conversations where id = $1",
          [convId],
        );
        expect(conv!.status).not.toBe("closed");
        expect(await audit(convId)).toEqual([]);
        expect(
          Number(
            (
              await q<{ n: string }>(
                "select count(*)::text as n from public.enquiries where contact_id = $1",
                [k],
              )
            )[0]!.n,
          ),
        ).toBe(0);
      });
    });
  },
);
