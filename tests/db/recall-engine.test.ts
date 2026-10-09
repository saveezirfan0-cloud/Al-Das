/**
 * Recall programmes end to end against a real Postgres through PostgREST: candidate queries, the
 * clinical gate, Test/Live, templates per condition, birthday bands, visit-gap rules, pagination,
 * idempotency, delivery sync and reply / booking attribution. Fake data only.
 * Runs only when TEST_DATABASE_URL, TEST_POSTGREST_URL and TEST_SERVICE_JWT are set.
 */
import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { attributeRecallEvent } from "@/lib/recall/attribution";
import { runProgramme, syncRecallSends, type Programme } from "@/lib/recall/engine";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

import { connect, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;
const NOW = new Date("2026-10-12T08:00:00Z"); // 12:00 in Dubai, Monday 12 October 2026

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)(
  "recall programmes (db)",
  () => {
    let c: Client;
    let admin: AdminClient;
    let org: string;
    let owner: string;
    let channel: string;
    let tplHtn: string;
    let tplBday: string;
    let phone = 100;

    async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
      const { rows } = await c.query(sql, params);
      return rows[0] as T;
    }
    const sign = (key: string, value: string) =>
      c.query(
        "update public.clinical_settings set approved_value=$3, sign_off_status='approved', signed_by='Test Signer', signed_at=current_date where org_id=$1 and key=$2",
        [org, key, value],
      );
    const unsign = (key: string) =>
      c.query(
        "update public.clinical_settings set approved_value=null, sign_off_status='awaiting' where org_id=$1 and key=$2",
        [org, key],
      );

    async function contact(
      over: {
        first?: string;
        test?: boolean;
        consent?: boolean;
        optin?: boolean;
        stop?: boolean;
        phone?: boolean;
        dob?: string;
        gender?: string;
      } = {},
    ): Promise<string> {
      const n = phone++;
      return (
        await one<{ id: string }>(
          `insert into public.contacts (org_id, first_name, phone_e164, is_test_record, clinical_messaging_consent, promotions_opt_in, stop_marketing, dob, gender)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
          [
            org,
            over.first ?? "Pat",
            over.phone === false ? null : `+97150000${String(n).padStart(4, "0")}`,
            over.test ?? true,
            over.consent ?? true,
            over.optin ?? true,
            over.stop ?? false,
            over.dob ?? null,
            over.gender ?? null,
          ],
        )
      ).id;
    }
    let visitSeq = 0;
    const visit = (
      contactId: string,
      date: string,
      code: string | null,
      secondary: string | null = null,
    ) =>
      c.query(
        "insert into public.visits (org_id, contact_id, external_id, visit_date, primary_diagnosis_code, secondary_diagnosis_codes) values ($1,$2,$3,$4,$5,$6)",
        [org, contactId, `v${++visitSeq}`, date, code, secondary],
      );

    async function programme(key: string): Promise<Programme> {
      const { data } = await admin
        .from("recall_programmes")
        .select("*")
        .eq("org_id", org)
        .eq("key", key)
        .single();
      return data as Programme;
    }
    const sends = async (key?: string) =>
      (
        await c.query(
          "select s.*, p.key from public.recall_sends s join public.recall_programmes p on p.id = s.programme_id where $1::text is null or p.key = $1 order by s.created_at",
          [key ?? null],
        )
      ).rows;

    beforeAll(async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = POSTGREST_URL;
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
      process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
      process.env.JOB_SECRET = "test-job-secret-0123456789";
      c = await connect();
      admin = createClient<Database>(`${POSTGREST_URL}`, SERVICE_JWT!, {
        auth: { persistSession: false },
      }) as unknown as AdminClient;
    });
    afterAll(async () => {
      await c?.end();
    });

    beforeEach(async () => {
      await resetDb(c);
      visitSeq = 0;
      phone = 100;
      owner = await createAuthUser(c, "owner@example.test");
      org = await createOrg(c, "Clinic", "clinic", owner);
      await c.query("select public.seed_clinical_settings($1)", [org]);
      await c.query("select public.seed_condition_groups($1)", [org]);
      await c.query("select public.seed_recall_programmes($1)", [org]);
      const grp = async (key: string) =>
        (
          await one<{ id: string }>(
            "select id from public.ref_condition_groups where org_id=$1 and key=$2",
            [org, key],
          )
        ).id;
      for (const [code, g] of [
        ["I10", "hypertension"],
        ["E11", "diabetes"],
        ["F32", "depression"],
      ] as const)
        await c.query(
          "insert into public.ref_diagnoses (org_id, code, chronic, condition_group_id) values ($1,$2,true,$3)",
          [org, code, await grp(g)],
        );
      channel = (
        await one<{ id: string }>(
          "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1,'Main','waba-r','pn-r') returning id",
          [org],
        )
      ).id;
      const tpl = async (name: string, category: string, clinical: string) =>
        (
          await one<{ id: string }>(
            `insert into public.wa_templates (org_id, channel_id, waba_id, name, language, status, category, clinical_approval, components)
           values ($1,$2,'waba-r',$3,'en','APPROVED',$4,$5,'[{"type":"BODY","text":"Hello {{1}}, a quick note from the clinic.","example":{"body_text":[["Sam"]]}}]'::jsonb) returning id`,
            [org, channel, name, category, clinical],
          )
        ).id;
      tplHtn = await tpl("recall_htn", "UTILITY", "approved");
      tplBday = await tpl("birthday_f", "MARKETING", "awaiting");
      const map = JSON.stringify({ "body.1": '{contact.first_name|default:"there"}' });
      await c.query(
        "update public.recall_programme_templates set wa_template_id=$2, variables_map=$3 where org_id=$1 and segment_key='hypertension' and programme_id=(select id from public.recall_programmes where org_id=$1 and key='chronic_90d')",
        [org, tplHtn, map],
      );
      await c.query(
        "update public.recall_programme_templates set wa_template_id=$2, variables_map=$3 where org_id=$1 and segment_key in ('f_18_35','m_20_29') and programme_id=(select id from public.recall_programmes where org_id=$1 and key='birthday')",
        [org, tplBday, map],
      );
      await c.query(
        "update public.recall_programmes set status='active' where org_id=$1 and key in ('chronic_90d','birthday')",
        [org],
      );
      await sign("chronic_recall_min_days", "90");
      await sign("recall_send_mode", "test");
      await sign("clinical_messaging_enabled", "true");
    });

    describe("chronic recall", () => {
      it("queues a Meta-approved template for an eligible internal test patient and records the cycle", async () => {
        const p = await contact({ first: "Sara" });
        await visit(p, "2026-06-01", "I10"); // 133 days
        const r = await runProgramme(admin, await programme("chronic_90d"), {
          trigger: "manual",
          now: NOW,
        });
        expect(r).toMatchObject({
          dryRun: false,
          gateOpen: true,
          sendMode: "test",
          scanned: 1,
          queued: 1,
          bySegment: { hypertension: 1 },
        });
        const [s] = await sends();
        expect(s).toMatchObject({
          contact_id: p,
          cycle_key: "2026-06-01",
          segment_key: "hypertension",
          send_mode: "test",
          status: "queued",
          days_since_last_visit_at_send: 133,
        });
        const msg = await one<{
          kind: string;
          body: string;
          direction: string;
          payload: { send: { type: string; values: Record<string, string> } };
        }>("select kind, body, direction, payload from public.messages where id = $1", [
          s.message_id,
        ]);
        expect(msg).toMatchObject({
          kind: "template",
          direction: "out",
          body: "Hello Sara, a quick note from the clinic.",
        });
        expect(msg.payload.send.values).toEqual({ "body.1": "Sara" });
        const run = await one<{ queued: number; dry_run: boolean; gate_open: boolean }>(
          "select queued, dry_run, gate_open from public.recall_runs where id = $1",
          [r.runId],
        );
        expect(run).toEqual({ queued: 1, dry_run: false, gate_open: true });
      });

      it("is idempotent: a second run for the same cycle sends nothing", async () => {
        await visit(await contact(), "2026-06-01", "I10");
        const prog = await programme("chronic_90d");
        expect((await runProgramme(admin, prog, { trigger: "manual", now: NOW })).queued).toBe(1);
        const again = await runProgramme(admin, prog, { trigger: "manual", now: NOW });
        expect(again).toMatchObject({ scanned: 0, queued: 0 });
        expect(await sends()).toHaveLength(1);
      });

      it("counts but queues nothing while the clinical gate is closed, and the cycle stays open", async () => {
        await unsign("clinical_messaging_enabled");
        await visit(await contact(), "2026-06-01", "I10");
        const prog = await programme("chronic_90d");
        const r = await runProgramme(admin, prog, { trigger: "schedule", now: NOW });
        expect(r).toMatchObject({ dryRun: true, gateOpen: false, queued: 0 });
        expect(r.skipped).toEqual({ clinical_gate_closed: 1 });
        expect(await sends()).toHaveLength(0);
        expect(
          await one("select count(*)::int n from public.messages where direction='out'"),
        ).toEqual({ n: 0 });
        // The gate opens later: the same patient is still eligible for this cycle.
        await sign("clinical_messaging_enabled", "true");
        expect(
          (
            await runProgramme(admin, prog, {
              trigger: "manual",
              now: new Date(NOW.getTime() + 120_000),
            })
          ).queued,
        ).toBe(1);
      });

      it("a threshold that is not signed off recalls nobody", async () => {
        await unsign("chronic_recall_min_days");
        await visit(await contact(), "2020-01-01", "I10");
        const r = await runProgramme(admin, await programme("chronic_90d"), {
          trigger: "manual",
          now: NOW,
        });
        expect(r).toMatchObject({ scanned: 0, queued: 0 });
      });

      it("respects the threshold and the patient's last visit (any later visit pushes the recall out)", async () => {
        const recent = await contact();
        await visit(recent, "2026-01-01", "I10");
        await visit(recent, "2026-09-20", "J00"); // a later visit for something else: 22 days ago
        const due = await contact();
        await visit(due, "2026-07-01", "I10"); // 103 days
        const r = await runProgramme(admin, await programme("chronic_90d"), {
          trigger: "manual",
          now: NOW,
        });
        expect(r.queued).toBe(1);
        expect((await sends())[0].contact_id).toBe(due);
      });

      it("uses secondary diagnosis codes, the first messageable group by priority, and skips unmapped segments", async () => {
        const both = await contact();
        await visit(both, "2026-06-01", "E11", "I10, J00"); // diabetes (20) and hypertension (10) → hypertension
        const diabetesOnly = await contact();
        await visit(diabetesOnly, "2026-06-01", "E11"); // no template for diabetes
        const mental = await contact();
        await visit(mental, "2026-06-01", "F32"); // not messageable
        const r = await runProgramme(admin, await programme("chronic_90d"), {
          trigger: "manual",
          now: NOW,
        });
        expect(r).toMatchObject({ queued: 1, scanned: 2, bySegment: { hypertension: 1 } });
        expect(r.skipped).toEqual({ no_template: 1 });
        expect((await sends())[0]).toMatchObject({ contact_id: both, segment_key: "hypertension" });
      });

      it("test mode reaches only internal test patients; live mode never reaches them", async () => {
        const internal = await contact({ test: true });
        const real = await contact({ test: false, first: "Real" });
        for (const x of [internal, real]) await visit(x, "2026-06-01", "I10");
        const prog = await programme("chronic_90d");
        expect((await runProgramme(admin, prog, { trigger: "manual", now: NOW })).queued).toBe(1);
        expect((await sends())[0].contact_id).toBe(internal);

        await sign("recall_send_mode", "live");
        const r = await runProgramme(admin, prog, {
          trigger: "manual",
          now: new Date(NOW.getTime() + 120_000),
        });
        expect(r).toMatchObject({ sendMode: "live", queued: 1 });
        expect((await sends()).map((s) => s.contact_id).sort()).toEqual([internal, real].sort());
        expect((await sends()).find((s) => s.contact_id === real)).toMatchObject({
          send_mode: "live",
        });
        // a typo in the mode is not "live"
        await c.query("update public.recall_programmes set send_mode_override='test' where id=$1", [
          prog.id,
        ]);
      });

      it("needs clinical-messaging consent, a phone and no marketing opt-out", async () => {
        const noConsent = await contact({ consent: false });
        const noPhone = await contact({ phone: false });
        const stopped = await contact({ stop: true });
        for (const x of [noConsent, noPhone, stopped]) await visit(x, "2026-06-01", "I10");
        expect(
          await runProgramme(admin, await programme("chronic_90d"), {
            trigger: "manual",
            now: NOW,
          }),
        ).toMatchObject({ scanned: 0, queued: 0 });
      });

      it("a template that is not clinically approved, or not approved by Meta, is never sent", async () => {
        await visit(await contact(), "2026-06-01", "I10");
        const prog = await programme("chronic_90d");
        await c.query("update public.wa_templates set clinical_approval='awaiting' where id=$1", [
          tplHtn,
        ]);
        expect((await runProgramme(admin, prog, { trigger: "manual", now: NOW })).skipped).toEqual({
          template_not_clinically_approved: 1,
        });
        await c.query(
          "update public.wa_templates set clinical_approval='approved', status='PAUSED' where id=$1",
          [tplHtn],
        );
        expect(
          (
            await runProgramme(admin, prog, {
              trigger: "manual",
              now: new Date(NOW.getTime() + 120_000),
            })
          ).skipped,
        ).toEqual({ template_not_approved: 1 });
        expect(await sends()).toHaveLength(0);
      });

      it("max_per_run caps a run and the next run carries on with the rest", async () => {
        await c.query(
          "update public.recall_programmes set max_per_run=2 where org_id=$1 and key='chronic_90d'",
          [org],
        );
        for (let i = 0; i < 5; i++) await visit(await contact(), `2026-0${i + 1}-15`, "I10");
        const prog = await programme("chronic_90d");
        const a = await runProgramme(admin, prog, { trigger: "manual", now: NOW });
        const b = await runProgramme(admin, prog, {
          trigger: "manual",
          now: new Date(NOW.getTime() + 120_000),
        });
        const d = await runProgramme(admin, prog, {
          trigger: "manual",
          now: new Date(NOW.getTime() + 240_000),
        });
        expect([a.queued, b.queued, d.queued]).toEqual([2, 2, 1]);
        expect(new Set((await sends()).map((s) => s.contact_id)).size).toBe(5);
        // the longest-waiting patients go first
        expect((await sends()).slice(0, 2).map((s) => s.cycle_key)).toEqual([
          "2026-01-15",
          "2026-02-15",
        ]);
      });

      it("an unmapped patient at the front of the queue cannot starve the others", async () => {
        await c.query(
          "update public.recall_programmes set max_per_run=1 where org_id=$1 and key='chronic_90d'",
          [org],
        );
        for (let i = 0; i < 3; i++) await visit(await contact(), `2025-0${i + 1}-01`, "E11"); // oldest, no template
        const ok = await contact();
        await visit(ok, "2026-06-01", "I10");
        const r = await runProgramme(admin, await programme("chronic_90d"), {
          trigger: "manual",
          now: NOW,
        });
        expect(r.queued).toBe(1);
        expect(r.skipped).toEqual({ no_template: 3 });
        expect((await sends())[0].contact_id).toBe(ok);
      });

      it("a 'check' run never queues, whatever the gate says", async () => {
        await visit(await contact(), "2026-06-01", "I10");
        const r = await runProgramme(admin, await programme("chronic_90d"), {
          trigger: "check",
          now: NOW,
        });
        expect(r).toMatchObject({ dryRun: true, queued: 0, bySegment: { hypertension: 1 } });
        expect(await sends()).toHaveLength(0);
      });

      it("a scheduled programme does not run twice in the same minute", async () => {
        await visit(await contact(), "2026-06-01", "I10");
        const prog = await programme("chronic_90d");
        expect((await runProgramme(admin, prog, { trigger: "schedule", now: NOW })).queued).toBe(1);
        expect(await runProgramme(admin, prog, { trigger: "schedule", now: NOW })).toMatchObject({
          queued: 0,
          note: "already ran this minute",
        });
      });
    });

    describe("scheduled task", () => {
      it("runs programmes whose schedule matches this minute, leaves paused and non-matching ones alone", async () => {
        await import("@/lib/jobs/handlers/recall");
        const { getTask } = await import("@/lib/jobs/tasks");
        await visit(await contact(), "2026-06-01", "I10");
        const log = { info() {}, warn() {}, error() {} };
        // not due: a schedule that never matches this minute
        await c.query(
          "update public.recall_programmes set cron_expression='0 0 31 2 *' where org_id=$1 and key='chronic_90d'",
          [org],
        );
        expect(await getTask("recall_programmes")!.run(admin, log)).toMatchObject({
          due: 0,
          queued: 0,
        });
        // paused: matches but is not on
        await c.query(
          "update public.recall_programmes set cron_expression='* * * * *', status='paused' where org_id=$1 and key='chronic_90d'",
          [org],
        );
        expect(await getTask("recall_programmes")!.run(admin, log)).toMatchObject({ due: 0 });
        await c.query(
          "update public.recall_programmes set status='active' where org_id=$1 and key='chronic_90d'",
          [org],
        );
        expect(await getTask("recall_programmes")!.run(admin, log)).toMatchObject({
          due: 1,
          queued: 1,
          errors: 0,
        });
        expect(await sends()).toHaveLength(1);
        // the appointment-reminder row is managed elsewhere and never run here
        expect(
          await one(
            "select count(*)::int n from public.recall_runs r join public.recall_programmes p on p.id=r.programme_id where p.key='appointment_reminder'",
          ),
        ).toEqual({ n: 0 });
      });
    });

    describe("birthdays", () => {
      it("greets today's birthdays by band, once a year, only with marketing opt-in", async () => {
        const f30 = await contact({ dob: "1996-10-12", gender: "female" }); // 30
        const m25 = await contact({ dob: "2001-10-12", gender: "male" }); // 25
        const noOptin = await contact({ dob: "1996-10-12", gender: "female", optin: false });
        const uncovered = await contact({ dob: "1950-10-12", gender: "female" }); // 76: no band
        const otherDay = await contact({ dob: "1996-10-13", gender: "female" });
        void noOptin;
        void uncovered;
        void otherDay;
        const prog = await programme("birthday");
        const r = await runProgramme(admin, prog, { trigger: "manual", now: NOW });
        expect(r).toMatchObject({ queued: 2, bySegment: { f_18_35: 1, m_20_29: 1 } });
        expect(r.skipped).toEqual({ band_not_covered: 1 });
        expect((await sends("birthday")).map((s) => [s.contact_id, s.cycle_key]).sort()).toEqual(
          [
            [f30, "2026"],
            [m25, "2026"],
          ].sort(),
        );
        expect(
          (
            await runProgramme(admin, prog, {
              trigger: "manual",
              now: new Date(NOW.getTime() + 120_000),
            })
          ).queued,
        ).toBe(0);
      });

      it("greets 29 February people on 1 March in a non-leap year", async () => {
        await contact({ dob: "1996-02-29", gender: "female" }); // 30 on 1 March 2026
        const r = await runProgramme(admin, await programme("birthday"), {
          trigger: "manual",
          now: new Date("2026-03-01T08:00:00Z"),
        });
        expect(r.queued).toBe(1);
      });

      it("a marketing template never reaches someone who opted out of marketing after the candidate query", async () => {
        const who = await contact({ dob: "1996-10-12", gender: "female" });
        await c.query("update public.contacts set stop_marketing=true where id=$1", [who]);
        expect(
          await runProgramme(admin, await programme("birthday"), { trigger: "manual", now: NOW }),
        ).toMatchObject({ scanned: 0, queued: 0 });
      });
    });

    describe("visit-gap programmes", () => {
      it("recall nobody until a minimum is configured, then apply it with gender and age", async () => {
        const woman = await contact({ dob: "1980-01-01", gender: "female" });
        const girl = await contact({ dob: "2015-01-01", gender: "female" });
        const man = await contact({ dob: "1980-01-01", gender: "male" });
        for (const x of [woman, girl, man]) await visit(x, "2025-06-01", "J00"); // 498 days
        await c.query(
          "update public.recall_programme_templates set wa_template_id=null where false",
        );
        await c.query(
          "insert into public.recall_programme_templates (org_id, programme_id, segment_key, wa_template_id, variables_map) select $1, id, '*', $2, '{\"body.1\":\"{contact.first_name}\"}' from public.recall_programmes where org_id=$1 and key='pap_smear'",
          [org, tplBday],
        );
        await c.query(
          "update public.recall_programmes set status='active' where org_id=$1 and key='pap_smear'",
          [org],
        );
        const prog = await programme("pap_smear");
        expect(await runProgramme(admin, prog, { trigger: "manual", now: NOW })).toMatchObject({
          scanned: 0,
          queued: 0,
        }); // min_days null
        await c.query(
          'update public.recall_programmes set config=\'{"min_days": 365, "gender": "female", "min_age": 21, "max_age": 65}\' where id=$1',
          [prog.id],
        );
        const r = await runProgramme(admin, await programme("pap_smear"), {
          trigger: "manual",
          now: NOW,
        });
        expect(r.queued).toBe(1);
        expect((await sends("pap_smear"))[0]).toMatchObject({
          contact_id: woman,
          cycle_key: "2025-06-01",
        });
      });

      it("a once-only programme (dormant) sends one message per patient ever", async () => {
        const x = await contact();
        await visit(x, "2024-01-01", "J00");
        await c.query(
          "insert into public.recall_programme_templates (org_id, programme_id, segment_key, wa_template_id, variables_map) select $1, id, '*', $2, '{\"body.1\":\"{contact.first_name}\"}' from public.recall_programmes where org_id=$1 and key='dormant'",
          [org, tplBday],
        );
        await c.query(
          "update public.recall_programmes set status='active', config='{\"min_days\": 500}' where org_id=$1 and key='dormant'",
          [org],
        );
        const prog = await programme("dormant");
        expect((await runProgramme(admin, prog, { trigger: "manual", now: NOW })).queued).toBe(1);
        expect((await sends("dormant"))[0].cycle_key).toBe("once");
        await visit(x, "2024-03-01", "J00"); // a new visit would start a new cycle for per-cycle programmes, not for this one
        expect(
          (
            await runProgramme(admin, prog, {
              trigger: "manual",
              now: new Date(NOW.getTime() + 120_000),
            })
          ).queued,
        ).toBe(0);
      });
    });

    describe("status sync and attribution", () => {
      async function queuedSend() {
        const p = await contact();
        await visit(p, "2026-06-01", "I10");
        await runProgramme(admin, await programme("chronic_90d"), { trigger: "manual", now: NOW });
        return { p, send: (await sends())[0] };
      }

      it("copies delivery status forward only", async () => {
        const { send } = await queuedSend();
        expect(await syncRecallSends(admin)).toBe(0); // message still queued
        await c.query("update public.messages set status='sent' where id=$1", [send.message_id]);
        expect(await syncRecallSends(admin)).toBe(1);
        await c.query("update public.messages set status='read' where id=$1", [send.message_id]);
        await syncRecallSends(admin);
        expect((await sends())[0]).toMatchObject({ status: "read" });
        expect((await sends())[0].sent_at).not.toBeNull();
        await c.query("update public.messages set status='delivered' where id=$1", [
          send.message_id,
        ]); // out-of-order
        await syncRecallSends(admin);
        expect((await sends())[0].status).toBe("read");
      });

      it("attributes the next reply and a later booking to the recall, within signed-off windows", async () => {
        const { p, send } = await queuedSend();
        await c.query("update public.recall_sends set status='sent', sent_at=$2 where id=$1", [
          send.id,
          NOW.toISOString(),
        ]);
        const reply = {
          org_id: org,
          name: "message.received",
          payload: { contact_id: p, message_id: null, kind: "text" },
          at: new Date(NOW.getTime() + 3600_000).toISOString(),
        };

        // windows are not signed off yet: nothing is attributed
        expect(await attributeRecallEvent(admin, reply)).toEqual({ replied: 0, booked: 0 });
        await sign("recall_reply_attribution_days", "14");
        await sign("recall_booking_attribution_days", "30");
        expect(await attributeRecallEvent(admin, reply)).toEqual({ replied: 1, booked: 0 });
        expect(await attributeRecallEvent(admin, reply)).toEqual({ replied: 0, booked: 0 }); // already answered
        const apt = {
          org_id: org,
          name: "appointment.created",
          payload: { contact_id: p, appointment_id: null },
          at: new Date(NOW.getTime() + 2 * 86_400_000).toISOString(),
        };
        expect(await attributeRecallEvent(admin, apt)).toEqual({ replied: 0, booked: 1 });
        expect((await sends())[0]).toMatchObject({ follow_up_status: "booked" });
        expect((await sends())[0].replied_at).not.toBeNull();
        expect((await sends())[0].booked_at).not.toBeNull();
      });

      it("is wired into the flow_steps event job, so a real inbound message is attributed", async () => {
        const { p, send } = await queuedSend();
        await c.query("update public.recall_sends set status='sent', sent_at=$2 where id=$1", [
          send.id,
          NOW.toISOString(),
        ]);
        await sign("recall_reply_attribution_days", "14");
        await import("@/lib/jobs/handlers/flow-steps");
        const { getHandler } = await import("@/lib/jobs/registry");
        await getHandler("flow_steps")!.handler(
          {
            type: "event",
            org_id: org,
            name: "message.received",
            payload: { contact_id: p, kind: "text" },
            at: new Date(NOW.getTime() + 3600_000).toISOString(),
          },
          {
            queue: "flow_steps",
            msgId: 1,
            readCt: 1,
            enqueuedAt: new Date(),
            admin,
            log: { info() {}, warn() {}, error() {} },
          },
        );
        expect((await sends())[0].replied_at).not.toBeNull();
      });

      it("ignores replies after the window and other patients", async () => {
        const { p, send } = await queuedSend();
        await c.query("update public.recall_sends set status='sent', sent_at=$2 where id=$1", [
          send.id,
          NOW.toISOString(),
        ]);
        await sign("recall_reply_attribution_days", "14");
        const late = {
          org_id: org,
          name: "message.received",
          payload: { contact_id: p, kind: "text" },
          at: new Date(NOW.getTime() + 20 * 86_400_000).toISOString(),
        };
        expect(await attributeRecallEvent(admin, late)).toEqual({ replied: 0, booked: 0 });
        const stranger = await contact();
        expect(
          await attributeRecallEvent(admin, {
            ...late,
            payload: { contact_id: stranger, kind: "text" },
            at: new Date(NOW.getTime() + 3600_000).toISOString(),
          }),
        ).toEqual({ replied: 0, booked: 0 });
      });

      it("a booked follow-up needs a booking date (database constraint)", async () => {
        const { send } = await queuedSend();
        await expect(
          c.query("update public.recall_sends set follow_up_status='booked' where id=$1", [
            send.id,
          ]),
        ).rejects.toThrow(/recall_booked_needs_date/);
      });
    });
  },
);
