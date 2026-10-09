/**
 * The clinical engine against a real Postgres + PostgREST: unsigned vs signed settings, idempotent
 * evaluation, the Follow-Up Queue (create / supersede / close / leave alone), the patient-facing
 * gate on every message, red flags with dual notification, and the day-3 reply flow.
 * Fake data only. Needs TEST_POSTGREST_URL / TEST_SERVICE_JWT (supabase/test/README.md).
 */
import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyDay3Reply,
  dispatchClinicalMessage,
  evaluateRecentVisits,
  evaluateVisitById,
  recordFeedback,
} from "@/lib/clinical/engine";
import "@/lib/jobs/handlers/clinical";
import { getTask } from "@/lib/jobs/tasks";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

import { connect, count, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;
const log = { info: () => {}, warn: () => {}, error: () => {} };

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)("clinical engine", () => {
  let c: Client;
  let admin: AdminClient;
  let org: string;
  const u: Record<string, string> = {};
  const id: Record<string, string> = {};

  const q = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows;
  const ins = async (sql: string, p: unknown[]) =>
    (await c.query(sql + " returning id", p)).rows[0].id as string;
  const sql = async <T>(fn: () => Promise<T>) => {
    await c.query("set role service_role");
    try {
      return await fn();
    } finally {
      await c.query("reset role");
    }
  };
  const visitRow = (over: Record<string, unknown> = {}) => ({
    org_id: org,
    external_id: `V-${Math.random().toString(36).slice(2, 8)}`,
    visit_date: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
    department_raw: "General Practice",
    contact_id: id.adult,
    ...over,
  });
  const addVisit = async (over: Record<string, unknown> = {}) => {
    const { data, error } = await admin.from("visits").insert(visitRow(over)).select("*").single();
    if (error) throw new Error(error.message);
    return data;
  };
  const signAll = () =>
    sql(async () => {
      await c.query(
        `update public.clinical_settings set approved_value = proposed_value, sign_off_status = 'approved',
           signed_by = 'Test Signer', signed_at = current_date
         where org_id = $1 and proposed_value is not null and key not in ('clinical_messaging_enabled','allow_unsigned_defaults')`,
        [org],
      );
      await c.query(
        `update public.clinical_settings set approved_value = $2, sign_off_status = 'approved', signed_by = 'Test Signer', signed_at = current_date
         where org_id = $1 and key = 'day3_halt_threshold'`,
        [org, "4"],
      );
      await c.query(
        `update public.clinical_settings set approved_value = $2, sign_off_status = 'approved', signed_by = 'Test Signer', signed_at = current_date
         where org_id = $1 and key = 'side_effect_keywords'`,
        [org, JSON.stringify(["rash", "swelling", "vomiting"])],
      );
    });
  const openGate = () =>
    sql(() =>
      c.query(
        `update public.clinical_settings set approved_value='true', sign_off_status='approved', signed_by='Test Signer', signed_at=current_date
         where org_id=$1 and key='clinical_messaging_enabled'`,
        [org],
      ),
    );

  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = POSTGREST_URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
    process.env.JOB_SECRET = "test-job-secret-0123456789";

    c = await connect();
    await resetDb(c);
    for (const n of ["admin", "coordinator", "doctor"])
      u[n] = await createAuthUser(c, `${n}@example.test`);
    org = await createOrg(c, "Org C", "org-c", u.admin);
    admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
      auth: { persistSession: false },
    }) as AdminClient;

    await c.query("set role service_role");
    const roleId = await ins(
      "insert into public.roles (org_id, name, permissions) values ($1,'Coordinator','[\"portal.clinical_followups.write\"]')",
      [org],
    );
    await c.query(
      "insert into public.memberships (org_id, user_id, role_id, status) values ($1,$2,$3,'active')",
      [org, u.coordinator, roleId],
    );
    await c.query("select public.seed_clinical_settings($1)", [org]);
    id.adult = await ins(
      "insert into public.contacts (org_id, first_name, phone_e164, dob) values ($1,'Adult','+971500000101','1985-06-15')",
      [org],
    );
    id.child = await ins(
      "insert into public.contacts (org_id, first_name, phone_e164, dob) values ($1,'Child','+971500000102',(current_date - interval '3 years')::date)",
      [org],
    );
    id.tester = await ins(
      "insert into public.contacts (org_id, first_name, phone_e164, is_test_record, clinical_messaging_consent) values ($1,'Internal','+971500000103',true,true)",
      [org],
    );
    id.real = await ins(
      "insert into public.contacts (org_id, first_name, phone_e164, clinical_messaging_consent) values ($1,'Patient','+971500000104',true)",
      [org],
    );
    id.doctor = await ins(
      "insert into public.specialists (org_id, name, user_id) values ($1,'Dr Linked',$2)",
      [org, u.doctor],
    );
    id.channel = await ins(
      "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1,'Main','waba-c','pn-c')",
      [org],
    );
    id.tpl = await ins(
      `insert into public.wa_templates (org_id, channel_id, waba_id, name, language, category, status, components, internal_key, clinical_approval)
       values ($1,$2,'waba-c','abx_day3','en','UTILITY','APPROVED','[{"type":"BODY","text":"Hello {{1}}, how are you feeling (1-10)?"}]','ABX_DAY3','approved')`,
      [org, id.channel],
    );
    await c.query("reset role");
  });

  afterAll(async () => {
    await c?.end();
  });

  describe("evaluation and the Follow-Up Queue", () => {
    let sick: Awaited<ReturnType<typeof addVisit>>;

    it("with nothing signed off a high fever fires nothing and says which settings were missing", async () => {
      sick = await addVisit({ external_id: "V-sick", temp_c: 39.8 });
      const r = await evaluateVisitById(admin, org, sick.id);
      expect(r).toMatchObject({ outcome: "evaluated", followUp: "none" });
      expect(r.evaluation?.rulesFired).toEqual([]);
      const ev = (
        await q(
          "select missing_settings, rules_fired from public.visit_rule_evaluations where visit_id=$1 and is_current",
          [sick.id],
        )
      )[0];
      // the child/adult cut-off is unsigned, so the department is undetermined and no department rules run
      expect(ev.missing_settings).toContain("paeds_age_cutoff_years");
      expect(await count(c, "select 1 from public.clinical_followups")).toBe(0);
    });

    it("once signed off, the same visit is re-evaluated and queued once", async () => {
      await signAll();
      const r = await evaluateVisitById(admin, org, sick.id);
      expect(r).toMatchObject({ outcome: "evaluated", followUp: "created" });
      expect(r.evaluation).toMatchObject({
        rulesFired: ["GP-01-VITALS"],
        triggerCategory: "vitals",
      });
      const fu = (
        await q(
          "select priority, source, dedupe_key, due_date::text as due from public.clinical_followups",
        )
      )[0];
      expect(fu).toMatchObject({ priority: "high", source: "engine", dedupe_key: "V-sick-vitals" });
      expect(new Date(fu.due).getTime()).toBeGreaterThan(new Date(sick.visit_date).getTime());
      // old evaluation retired, one current
      expect(
        await count(c, "select 1 from public.visit_rule_evaluations where visit_id=$1", [sick.id]),
      ).toBe(2);
      expect(
        await count(
          c,
          "select 1 from public.visit_rule_evaluations where visit_id=$1 and is_current",
          [sick.id],
        ),
      ).toBe(1);
    });

    it("is idempotent: a re-sync creates nothing and re-evaluates nothing", async () => {
      expect(await evaluateVisitById(admin, org, sick.id)).toMatchObject({
        outcome: "unchanged",
        followUp: "none",
      });
      await expect(evaluateRecentVisits(admin, org)).resolves.toMatchObject({
        created: 0,
        evaluated: 0,
      });
      expect(await count(c, "select 1 from public.clinical_followups")).toBe(1);
    });

    it("closes an untouched follow-up when the rules stop firing, and reopens the key later", async () => {
      await admin.from("visits").update({ temp_c: 36.8 }).eq("id", sick.id);
      expect(await evaluateVisitById(admin, org, sick.id)).toMatchObject({
        outcome: "evaluated",
        followUp: "closed",
      });
      expect(
        (await q("select closed_reason from public.clinical_followups"))[0].closed_reason,
      ).toBe("no_longer_triggered");
      await admin.from("visits").update({ temp_c: 39.9 }).eq("id", sick.id);
      expect(await evaluateVisitById(admin, org, sick.id)).toMatchObject({ followUp: "created" });
      expect(
        await count(c, "select 1 from public.clinical_followups where closed_at is null"),
      ).toBe(1);
    });

    it("supersedes an untouched follow-up on a category change but never one a person is working on", async () => {
      await admin
        .from("visits")
        .update({ temp_c: null, procedure_notes: "wound dressing" })
        .eq("id", sick.id);
      expect(await evaluateVisitById(admin, org, sick.id)).toMatchObject({ followUp: "created" });
      const rows = await q(
        "select dedupe_key, closed_reason from public.clinical_followups order by created_at",
      );
      expect(rows.at(-2)).toMatchObject({
        dedupe_key: "V-sick-vitals",
        closed_reason: "superseded",
      });
      expect(rows.at(-1)).toMatchObject({
        dedupe_key: "V-sick-post_procedure",
        closed_reason: null,
      });

      // a nurse starts working the post-procedure item, then the category changes again
      await c.query(
        "update public.clinical_followups set call_status='no_answer' where dedupe_key='V-sick-post_procedure'",
      );
      await admin.from("visits").update({ temp_c: 40.1 }).eq("id", sick.id);
      expect(await evaluateVisitById(admin, org, sick.id)).toMatchObject({ followUp: "created" });
      const worked = (
        await q(
          "select closed_at from public.clinical_followups where dedupe_key='V-sick-post_procedure'",
        )
      )[0];
      expect(worked.closed_at).toBeNull(); // left to the nurse
    });

    it("an under-14 is evaluated as paediatrics whatever the department says", async () => {
      const child = await addVisit({
        external_id: "V-child",
        contact_id: id.child,
        temp_c: 39.4,
        department_raw: "General Practice",
      });
      const r = await evaluateVisitById(admin, org, child.id);
      expect(r.evaluation).toMatchObject({
        departmentEffective: "paediatrics",
        triggerCategory: "paediatric_high_concern",
      });
      const fu = (
        await q(
          "select priority, trigger_category from public.clinical_followups where dedupe_key='V-child-paediatric_high_concern'",
        )
      )[0];
      expect(fu).toEqual({ priority: "high", trigger_category: "paediatric_high_concern" });
    });

    it("negated findings in the notes do not trigger (scrubbing runs on the stored notes)", async () => {
      const v = await addVisit({
        external_id: "V-denies",
        observation_notes_raw: "denies chest pain, no shortness of breath",
      });
      const r = await evaluateVisitById(admin, org, v.id);
      expect(r.evaluation?.rulesFired).toEqual([]);
      const stored = (
        await q(
          "select observation_notes_scrubbed as s, scrub_version as v from public.visits where id=$1",
          [v.id],
        )
      )[0];
      expect(stored).toEqual({ s: "", v: 1 });
    });

    it("can evaluate history without queueing anything", async () => {
      const v = await addVisit({ external_id: "V-old", temp_c: 40.5 });
      expect(await evaluateVisitById(admin, org, v.id, { createFollowups: false })).toMatchObject({
        outcome: "evaluated",
        followUp: "none",
      });
      expect(
        await count(c, "select 1 from public.clinical_followups where dedupe_key = 'V-old-vitals'"),
      ).toBe(0);
    });

    it("the scheduled task evaluates new visits for orgs with clinical settings", async () => {
      await addVisit({ external_id: "V-task", temp_c: 39.9 });
      const result = (await getTask("clinical_evaluate")!.run(admin, log)) as {
        evaluated: number;
        created: number;
      };
      expect(result.evaluated).toBeGreaterThanOrEqual(1);
      expect(
        await count(
          c,
          "select 1 from public.clinical_followups where dedupe_key = 'V-task-vitals'",
        ),
      ).toBe(1);
    });
  });

  describe("the patient-facing gate", () => {
    const outbound = async () =>
      Number((await q("select count(*) as n from pgmq.q_outbound"))[0].n);
    const dispatch = (key: string, contact: string, over: Record<string, unknown> = {}) =>
      dispatchClinicalMessage(admin, {
        orgId: org,
        templateKey: "ABX_DAY3",
        contactId: contact,
        idempotencyKey: key,
        values: { "body.1": "Test" },
        ...over,
      });

    it("logs but sends nothing while clinical_messaging_enabled is not signed off", async () => {
      const before = await outbound();
      const messages = await count(c, "select 1 from public.messages");
      const r = await dispatch("rx-1:ABX_DAY3", id.tester);
      expect(r).toMatchObject({ ok: true, status: "suppressed_gate" });
      expect(await outbound()).toBe(before);
      expect(await count(c, "select 1 from public.messages")).toBe(messages);
      const row = (
        await q(
          "select status, block_reason, send_mode from public.clinical_message_log where idempotency_key='rx-1:ABX_DAY3'",
        )
      )[0];
      expect(row).toEqual({
        status: "suppressed_gate",
        block_reason: "clinical_messaging_not_signed_off",
        send_mode: "test",
      });
    });

    it("is idempotent per key", async () => {
      expect(await dispatch("rx-1:ABX_DAY3", id.tester)).toMatchObject({
        ok: true,
        status: "duplicate",
      });
      expect(
        await count(
          c,
          "select 1 from public.clinical_message_log where idempotency_key='rx-1:ABX_DAY3'",
        ),
      ).toBe(1);
    });

    it("with the gate open and send mode 'test', only internal test records receive anything", async () => {
      await openGate();
      const before = await outbound();
      expect(await dispatch("rx-2:ABX_DAY3", id.real)).toMatchObject({
        ok: true,
        status: "suppressed_test_record",
      });
      expect(await outbound()).toBe(before);

      const sent = await dispatch("rx-3:ABX_DAY3", id.tester);
      expect(sent).toMatchObject({ ok: true, status: "send" });
      expect(await outbound()).toBe(before + 1);
      const msg = (
        await q("select kind, status, body from public.messages where id=$1", [
          (sent as { messageId: string }).messageId,
        ])
      )[0];
      expect(msg).toMatchObject({ kind: "template", status: "queued" });
      expect(msg.body).toContain("Hello Test");
      expect(
        (
          await q(
            "select status from public.clinical_message_log where idempotency_key='rx-3:ABX_DAY3'",
          )
        )[0].status,
      ).toBe("sent");
    });

    it("blocks an unapproved template and a contact without consent", async () => {
      await sql(() =>
        c.query("update public.wa_templates set clinical_approval='awaiting' where id=$1", [
          id.tpl,
        ]),
      );
      expect(await dispatch("rx-4:ABX_DAY3", id.tester)).toMatchObject({
        ok: true,
        status: "blocked",
        reason: "template_not_clinically_approved",
      });
      await sql(() =>
        c.query("update public.wa_templates set clinical_approval='approved' where id=$1", [
          id.tpl,
        ]),
      );
      await sql(() =>
        c.query("update public.contacts set clinical_messaging_consent=false where id=$1", [
          id.tester,
        ]),
      );
      expect(await dispatch("rx-5:ABX_DAY3", id.tester)).toMatchObject({
        ok: true,
        status: "blocked",
        reason: "no_clinical_messaging_consent",
      });
      await sql(() =>
        c.query("update public.contacts set clinical_messaging_consent=true where id=$1", [
          id.tester,
        ]),
      );
    });

    it("closing the gate again stops everything immediately", async () => {
      await sql(() =>
        c.query(
          "update public.clinical_settings set approved_value=null, sign_off_status='awaiting' where org_id=$1 and key='clinical_messaging_enabled'",
          [org],
        ),
      );
      const before = await outbound();
      expect(await dispatch("rx-6:ABX_DAY3", id.tester)).toMatchObject({
        status: "suppressed_gate",
      });
      expect(await outbound()).toBe(before);
    });
  });

  describe("replies, red flags and the day-3 check", () => {
    let visitId: string;
    let rxId: string;

    beforeAll(async () => {
      const v = await addVisit({
        external_id: "V-rx",
        contact_id: id.adult,
        specialist_id: id.doctor,
      });
      visitId = v.id;
      rxId = await sql(() =>
        ins(
          "insert into public.prescriptions (org_id, visit_id, contact_id, external_key, medication_code, class, start_date, duration_days) values ($1,$2,$3,'V-rx-1','AMX','antibiotic', current_date, 7)",
          [org, visitId, id.adult],
        ),
      );
      await sql(() =>
        c.query(
          "insert into public.prescription_sequences (org_id, prescription_id, status) values ($1,$2,'awaiting_day3_reply')",
          [org, rxId],
        ),
      );
    });

    it("'8 but I have a rash' is a red flag: both parties notified, stamps written together, High follow-up", async () => {
      const r = await recordFeedback(admin, {
        orgId: org,
        contactId: id.adult,
        visitId,
        stage: "after_probiotics",
        replyText: "8 but I have a rash",
      });
      expect(r).toMatchObject({ redFlag: true, score: 8, needsHumanReview: true });
      const fb = (
        await q(
          "select score, reply_text, side_effects_flagged, needs_doctor_review, doctor_notified_at is not null as d, coordinator_notified_at is not null as k from public.clinical_feedback where id=$1",
          [r.feedbackId],
        )
      )[0];
      expect(fb).toEqual({
        score: 8,
        reply_text: "8 but I have a rash",
        side_effects_flagged: true,
        needs_doctor_review: true,
        d: true,
        k: true,
      });
      const notified = (
        await q("select distinct user_id from public.notifications where type='clinical.red_flag'")
      ).map((x) => x.user_id);
      expect(notified).toEqual(expect.arrayContaining([u.doctor, u.coordinator]));
      expect(
        (
          await q(
            "select priority, source, doctor_alert_required from public.clinical_followups where dedupe_key = $1",
            [`feedback-${r.feedbackId}`],
          )
        )[0],
      ).toEqual({
        priority: "high",
        source: "feedback",
        doctor_alert_required: true,
      });
    });

    it("a calm reply is stored verbatim and raises nothing", async () => {
      const follow = await count(c, "select 1 from public.clinical_followups");
      const r = await recordFeedback(admin, {
        orgId: org,
        contactId: id.adult,
        visitId,
        stage: "after_probiotics",
        replyText: "9, all better",
      });
      expect(r).toMatchObject({ redFlag: false, needsHumanReview: false, score: 9 });
      expect(await count(c, "select 1 from public.clinical_followups")).toBe(follow);
    });

    it("day 3: an unclear reply waits for a person; nothing is guessed", async () => {
      const r = await applyDay3Reply(admin, {
        orgId: org,
        prescriptionId: rxId,
        replyText: "not great honestly",
      });
      expect(r).toMatchObject({
        ok: true,
        score: null,
        decision: { action: "clarify", status: "awaiting_clarification" },
      });
      const seq = (
        await q(
          "select status, day3_score from public.prescription_sequences where prescription_id=$1",
          [rxId],
        )
      )[0];
      expect(seq).toEqual({ status: "awaiting_clarification", day3_score: null });
      expect(
        (
          await q("select priority, source from public.clinical_followups where dedupe_key=$1", [
            `day3-${rxId}`,
          ])
        )[0],
      ).toEqual({ priority: "medium", source: "sequence" });
    });

    it("day 3: a low score halts the sequence, alerts the doctor and queues a High item", async () => {
      await sql(() =>
        c.query("delete from public.clinical_followups where dedupe_key=$1", [`day3-${rxId}`]),
      );
      const r = await applyDay3Reply(admin, { orgId: org, prescriptionId: rxId, replyText: "3" });
      expect(r).toMatchObject({
        ok: true,
        decision: { action: "halt", sendTemplate: "ABX_UNWELL", alertDoctor: true },
      });
      const seq = (
        await q(
          "select status, day3_score, halted_at is not null as halted from public.prescription_sequences where prescription_id=$1",
          [rxId],
        )
      )[0];
      expect(seq).toEqual({ status: "halted_clinical", day3_score: 3, halted: true });
      expect(
        (
          await q(
            "select priority, doctor_alert_required from public.clinical_followups where dedupe_key=$1",
            [`day3-${rxId}`],
          )
        )[0],
      ).toEqual({ priority: "high", doctor_alert_required: true });
    });

    it("day 3 with the HALT threshold unsigned: every reply goes to a person", async () => {
      await sql(() =>
        c.query(
          "update public.clinical_settings set approved_value=null, sign_off_status='blocking' where org_id=$1 and key='day3_halt_threshold'",
          [org],
        ),
      );
      await sql(() =>
        c.query("delete from public.clinical_followups where dedupe_key=$1", [`day3-${rxId}`]),
      );
      const r = await applyDay3Reply(admin, { orgId: org, prescriptionId: rxId, replyText: "7" });
      expect(r).toMatchObject({
        ok: true,
        decision: { action: "human_review", sendTemplate: null },
      });
      expect(
        await count(c, "select 1 from public.clinical_followups where dedupe_key=$1", [
          `day3-${rxId}`,
        ]),
      ).toBe(1);
    });
  });
});
