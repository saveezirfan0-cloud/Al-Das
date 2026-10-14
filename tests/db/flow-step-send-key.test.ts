/**
 * Replay-safe flow steps (migration 20261122000100_flow_step_send_key.sql, docs/23_PHASE_20B_NOTES.md).
 *   - messages / appointments / fin_payment_requests.flow_step_key are unique when set; rows without a key are unaffected
 *   - book_appointment_for_flow_step books through book_appointment and stores the key in the same transaction; a second
 *     call with the key is refused (flow_step_booked) before anything is booked; the key is not a history change
 *   - requeue_lost_flow_message queues a keyed, still-queued message with no outbound job, at most once
 *   - both functions are service role only
 *   - through PostgREST (when TEST_POSTGREST_URL / TEST_SERVICE_JWT are set): the real flow send adapter and the booking
 *     service called twice with one step key return the same message / appointment, one outbound job, one confirmation
 * Synthetic data only.
 */
import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RunRecord } from "@/lib/flow-engine/deps";
import { emptyContext, flowStepKey } from "@/lib/flow-engine/types";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

import { connect, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;
const viaRest = Boolean(TEST_DATABASE_URL && POSTGREST_URL && SERVICE_JWT);

if (viaRest) {
  // createAdminClient() (used by lib/jobs/enqueue) reads these on first use.
  process.env.NEXT_PUBLIC_SUPABASE_URL = POSTGREST_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
  process.env.JOB_SECRET = "test-job-secret-0123456789abcdef";
}

const KEY = (n: number) => `00000000-0000-4000-8000-0000000000a1:${n}`;

/** The first Monday-to-Thursday at least `days` ahead, at hh:mm UTC (open whatever the org's working week). */
function weekdayAt(days: number, hour: number, minute: number): Date {
  const d = new Date(Date.now() + days * 86_400_000);
  while (d.getUTCDay() < 1 || d.getUTCDay() > 4) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

/** A clinic with one specialist working every day 09:00 to 12:00 (Asia/Dubai). */
async function seedClinic(c: Client, org: string) {
  const one = async (sql: string, params: unknown[]) =>
    (await c.query<{ id: string }>(sql + " returning id", params)).rows[0]!.id;
  const loc = await one("insert into public.locations (org_id, name) values ($1, 'Demo Clinic')", [
    org,
  ]);
  const dept = await one("insert into public.departments (org_id, name) values ($1, 'General')", [
    org,
  ]);
  const svc = await one(
    "insert into public.services (org_id, department_id, name, duration_min) values ($1, $2, 'Consultation', 30)",
    [org, dept],
  );
  const spec = await one(
    "insert into public.specialists (org_id, name, department_id) values ($1, 'Dr Demo', $2)",
    [org, dept],
  );
  for (let wd = 1; wd <= 7; wd++)
    await c.query(
      "insert into public.working_hours (org_id, specialist_id, location_id, weekday, start_min, end_min) values ($1,$2,$3,$4,540,720)",
      [org, spec, loc, wd],
    );
  return { loc, dept, svc, spec };
}

describe.skipIf(!TEST_DATABASE_URL)("flow step keys in SQL", () => {
  let c: Client;
  let org: string;
  let conv: string;
  let contact: string;
  let clinic: Awaited<ReturnType<typeof seedClinic>>;

  const one = async (sql: string, params: unknown[]) =>
    (await c.query<{ id: string }>(sql + " returning id", params)).rows[0]!.id;
  const insertMessage = (key: string | null, status = "queued") =>
    one(
      "insert into public.messages (org_id, conversation_id, direction, kind, body, status, flow_step_key) values ($1, $2, 'out', 'text', 'Hello', $4, $3)",
      [org, conv, key, status],
    );
  const jobs = async (id: string) =>
    (
      await c.query<{ n: number }>(
        "select ((select count(*) from pgmq.q_outbound where message ->> 'message_id' = $1) + (select count(*) from pgmq.q_outbound_priority where message ->> 'message_id' = $1))::int as n",
        [id],
      )
    ).rows[0]!.n;
  const requeue = async (id: string, queue = "outbound") =>
    (
      await c.query<{ v: boolean }>("select public.requeue_lost_flow_message($1, $2) as v", [
        id,
        queue,
      ])
    ).rows[0]!.v;
  const bookForStep = async (key: string | null, startsAt: Date) =>
    (
      await c.query<{ id: string; flow_step_key: string }>(
        `select (b).id, (b).flow_step_key from (select public.book_appointment_for_flow_step(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, 'awaiting', null, false, 'bot', null, true) as b) x`,
        [
          key,
          org,
          contact,
          clinic.loc,
          clinic.spec,
          clinic.svc,
          clinic.dept,
          startsAt.toISOString(),
          new Date(startsAt.getTime() + 30 * 60_000).toISOString(),
        ],
      )
    ).rows[0]!;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    const user = await createAuthUser(c, "flowkey-owner@example.test");
    org = await createOrg(c, "Flow Key Org", "flow-key-org", user);
    const channel = await one(
      "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'Main', 'WABA-FK', '109900000000071')",
      [org],
    );
    contact = await one(
      "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Layla', 'Demo-07', '+447700900071')",
      [org],
    );
    conv = await one(
      "insert into public.conversations (org_id, channel_id, contact_id, last_inbound_at) values ($1, $2, $3, now())",
      [org, channel, contact],
    );
    clinic = await seedClinic(c, org);
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("refuses a second message with the same step key", async () => {
    await insertMessage(KEY(2));
    await expect(insertMessage(KEY(2))).rejects.toMatchObject({
      code: "23505",
      constraint: "messages_flow_step_key_uidx",
    });
    const { rows } = await c.query(
      "select count(*)::int as n from public.messages where flow_step_key = $1",
      [KEY(2)],
    );
    expect(rows[0].n).toBe(1);
  });

  it("accepts another step's key and any number of messages without a key", async () => {
    await insertMessage(KEY(3));
    await insertMessage(null);
    await insertMessage(null);
    const { rows } = await c.query(
      "select count(*)::int as n from public.messages where org_id = $1 and flow_step_key is null",
      [org],
    );
    expect(rows[0].n).toBe(2);
  });

  it("refuses an empty or oversized key", async () => {
    await expect(insertMessage("")).rejects.toMatchObject({ code: "23514" });
    await expect(insertMessage("x".repeat(121))).rejects.toMatchObject({ code: "23514" });
  });

  it("has partial unique indexes on all three keyed tables", async () => {
    const { rows } = await c.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes
        where schemaname = 'public' and indexname in
          ('messages_flow_step_key_uidx', 'appointments_flow_step_key_uidx', 'fin_payment_requests_flow_step_key_uidx')
        order by indexname`,
    );
    expect(rows.map((r) => r.indexname)).toEqual([
      "appointments_flow_step_key_uidx",
      "fin_payment_requests_flow_step_key_uidx",
      "messages_flow_step_key_uidx",
    ]);
    for (const r of rows)
      expect(r.indexdef).toMatch(/UNIQUE .*WHERE \(flow_step_key IS NOT NULL\)/);
  });

  it("requeue_lost_flow_message queues a keyed, still-queued message with no job, at most once", async () => {
    const lost = await insertMessage(KEY(10));
    expect(await jobs(lost)).toBe(0);
    expect(await requeue(lost)).toBe(true);
    expect(await jobs(lost)).toBe(1);
    // A second replay (or two at once): the claim is taken, nothing more is queued.
    expect(await requeue(lost)).toBe(false);
    await c.query("delete from pgmq.q_outbound where message ->> 'message_id' = $1", [lost]);
    expect(await requeue(lost)).toBe(false);
    expect(await jobs(lost)).toBe(0);
    const { rows } = await c.query(
      "select payload ? 'requeued_at' as flagged from public.messages where id = $1",
      [lost],
    );
    expect(rows[0].flagged).toBe(true);
  });

  it("requeue_lost_flow_message leaves waiting, sending, sent and unkeyed messages alone", async () => {
    const waiting = await insertMessage(KEY(11));
    await c.query(
      "select pgmq.send('outbound_priority', jsonb_build_object('message_id', $1::text))",
      [waiting],
    );
    expect(await requeue(waiting)).toBe(false);
    expect(await jobs(waiting)).toBe(1);
    for (const [n, status] of [
      [12, "sending"],
      [13, "sent"],
      [14, "failed"],
    ] as const) {
      const id = await insertMessage(KEY(n), status);
      expect(await requeue(id)).toBe(false);
      expect(await jobs(id)).toBe(0);
    }
    const unkeyed = await insertMessage(null);
    expect(await requeue(unkeyed)).toBe(false);
    await expect(requeue(unkeyed, "notifications")).rejects.toThrow(/unknown_queue/);
  });

  it("book_appointment_for_flow_step books once per key, in the same transaction as the key", async () => {
    const startsAt = new Date(Date.now() + 3 * 86_400_000);
    startsAt.setUTCHours(6, 0, 0, 0); // 10:00 in Dubai
    const first = await bookForStep(KEY(20), startsAt);
    expect(first.flow_step_key).toBe(KEY(20));
    // The replay is refused before book_appointment runs, whatever the slot's capacity.
    await expect(bookForStep(KEY(20), startsAt)).rejects.toThrow(/flow_step_booked/);
    await expect(bookForStep(KEY(20), new Date(startsAt.getTime() + 3_600_000))).rejects.toThrow(
      /flow_step_booked/,
    );
    const { rows } = await c.query(
      "select count(*)::int as n from public.appointments where flow_step_key = $1",
      [KEY(20)],
    );
    expect(rows[0].n).toBe(1);
    // The key is bookkeeping: the history shows the booking, not an edit.
    const history = await c.query(
      "select op from public.record_history where table_name = 'appointments' and record_id = $1",
      [first.id],
    );
    expect(history.rows).toEqual([{ op: "insert" }]);
    // The slot rule still applies to a new step (book_appointment's own check).
    await expect(bookForStep(KEY(21), startsAt)).rejects.toThrow(/slot_taken/);
    await expect(bookForStep(null, new Date(startsAt.getTime() + 3_600_000))).rejects.toThrow(
      /flow_step_key_required/,
    );
  });

  it("both functions are SECURITY DEFINER with a pinned search_path and for the service role only", async () => {
    const { rows } = await c.query<{
      name: string;
      anon: boolean;
      auth: boolean;
      svc: boolean;
      definer: boolean;
      config: string[] | null;
    }>(
      `select p.proname as name,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc,
              p.prosecdef as definer,
              p.proconfig as config
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('book_appointment_for_flow_step', 'requeue_lost_flow_message')
       order by p.proname`,
    );
    expect(rows).toEqual([
      {
        name: "book_appointment_for_flow_step",
        anon: false,
        auth: false,
        svc: true,
        definer: true,
        config: ['search_path=""'],
      },
      {
        name: "requeue_lost_flow_message",
        anon: false,
        auth: false,
        svc: true,
        definer: true,
        config: ['search_path=""'],
      },
    ]);
  });
});

describe.skipIf(!viaRest)("flow step replays through PostgREST", () => {
  let c: Client;
  let admin: AdminClient;
  let run: RunRecord;
  let org: string;
  let contact: string;
  let clinic: Awaited<ReturnType<typeof seedClinic>>;

  const one = async (sql: string, params: unknown[]) =>
    (await c.query<{ id: string }>(sql + " returning id", params)).rows[0]!.id;
  const count = async (sql: string, params: unknown[]) =>
    (await c.query<{ n: number }>(sql, params)).rows[0]!.n;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    const user = await createAuthUser(c, "flowkey-rest@example.test");
    org = await createOrg(c, "Flow Key Rest", "flow-key-rest", user);
    const channel = await one(
      "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'Main', 'WABA-FR', '109900000000072')",
      [org],
    );
    contact = await one(
      "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Omar', 'Demo-08', '+447700900072')",
      [org],
    );
    const conv = await one(
      "insert into public.conversations (org_id, channel_id, contact_id, last_inbound_at) values ($1, $2, $3, now())",
      [org, channel, contact],
    );
    clinic = await seedClinic(c, org);
    const tpl = await one(
      `insert into public.wa_templates (org_id, channel_id, waba_id, name, language, category, status, components)
       values ($1, $2, 'WABA-FR', 'visit_confirmed', 'en', 'UTILITY', 'APPROVED',
               '[{"type":"BODY","text":"Hi {{1}}, your visit is {{2}} with {{3}}."}]')`,
      [org, channel],
    );
    await c.query("update public.orgs set settings = $2::jsonb where id = $1", [
      org,
      JSON.stringify({ appointments: { templates: { confirmed: tpl }, lead_time_minutes: 0 } }),
    ]);
    const flow = await one(
      "insert into public.flows (org_id, name, status, trigger_type) values ($1, 'Replay test', 'draft', 'shortcut')",
      [org],
    );
    const runId = await one(
      "insert into public.flow_runs (org_id, flow_id, flow_version, contact_id, conversation_id, status, current_node_id, context) values ($1, $2, 1, $3, $4, 'running', 'm', '{}'::jsonb)",
      [org, flow, contact, conv],
    );
    run = {
      id: runId,
      org_id: org,
      flow_id: flow,
      flow_version: 1,
      contact_id: contact,
      conversation_id: conv,
      enquiry_id: null,
      status: "running",
      current_node_id: "m",
      context: emptyContext(),
      waiting_for: null,
      step_count: 1,
      parent_run_id: null,
      error: null,
    };
    admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
      auth: { persistSession: false },
    }) as AdminClient;
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("the same step key returns the first message: one row, one outbound job", async () => {
    const { supabaseActions } = await import("@/lib/flow-engine/supabase-deps");
    const actions = supabaseActions(admin);
    const key = flowStepKey(run.id, 2);
    const first = await actions.send(run, { type: "text", body: "Hello Omar" }, "Hello Omar", {
      stepKey: key,
    });
    const replay = await actions.send(run, { type: "text", body: "Hello Omar" }, "Hello Omar", {
      stepKey: key,
    });
    expect(replay.messageId).toBe(first.messageId);
    const rows = await c.query(
      "select id, flow_step_key, flow_run_id, status from public.messages where flow_step_key = $1",
      [key],
    );
    expect(rows.rows).toEqual([
      { id: first.messageId, flow_step_key: key, flow_run_id: run.id, status: "queued" },
    ]);
    expect(
      await count(
        "select count(*)::int as n from pgmq.q_outbound where message ->> 'message_id' = $1",
        [first.messageId],
      ),
    ).toBe(1);

    // The next step is a different key: a new message.
    const next = await actions.send(run, { type: "text", body: "Bye" }, "Bye", {
      stepKey: flowStepKey(run.id, 3),
    });
    expect(next.messageId).not.toBe(first.messageId);
  });

  it("a replay re-queues a message whose first enqueue was lost, exactly once", async () => {
    const { supabaseActions } = await import("@/lib/flow-engine/supabase-deps");
    const actions = supabaseActions(admin);
    const key = flowStepKey(run.id, 4);
    const first = await actions.send(run, { type: "text", body: "Lost" }, "Lost", { stepKey: key });
    // Simulate the crash between the insert and the enqueue: the row exists, the job does not.
    await c.query("delete from pgmq.q_outbound where message ->> 'message_id' = $1", [
      first.messageId,
    ]);
    await Promise.all([
      actions.send(run, { type: "text", body: "Lost" }, "Lost", { stepKey: key }),
      actions.send(run, { type: "text", body: "Lost" }, "Lost", { stepKey: key }),
    ]);
    await actions.send(run, { type: "text", body: "Lost" }, "Lost", { stepKey: key });
    expect(
      await count(
        "select count(*)::int as n from pgmq.q_outbound where message ->> 'message_id' = $1",
        [first.messageId],
      ),
    ).toBe(1);
    expect(
      await count("select count(*)::int as n from public.messages where flow_step_key = $1", [key]),
    ).toBe(1);
  });

  it("a replayed Book appointment step gets its booking and its one confirmation back", async () => {
    const { createAppointment } = await import("@/lib/appointments/service");
    const startsAt = weekdayAt(2, 6, 30); // 10:30 in Dubai
    const key = flowStepKey(run.id, 6);
    const book = () =>
      createAppointment(admin, {
        orgId: org,
        actorId: null,
        contactId: contact,
        locationId: clinic.loc,
        specialistId: clinic.spec,
        serviceId: clinic.svc,
        startsAt,
        notify: true,
        source: "bot",
        flowStepKey: key,
      });
    const first = await book();
    expect(first.ok ? "booked" : first.error).toBe("booked");
    if (!first.ok) return;
    expect(first.notification?.ok).toBe(true);
    const replay = await book();
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.appointment.id).toBe(first.appointment.id);
    if (first.notification?.ok && replay.notification?.ok)
      expect(replay.notification.messageId).toBe(first.notification.messageId);
    expect(
      await count("select count(*)::int as n from public.appointments where flow_step_key = $1", [
        key,
      ]),
    ).toBe(1);
    expect(
      await count(
        "select count(*)::int as n from public.messages where flow_step_key = $1 and kind = 'template'",
        [key],
      ),
    ).toBe(1);
    expect(
      await count(
        "select count(*)::int as n from public.timeline_events where org_id = $1 and type = 'appointment.created'",
        [org],
      ),
    ).toBe(1);
  });

  it("a crash between the booking and the confirmation: the replay sends the confirmation once", async () => {
    const { createAppointment } = await import("@/lib/appointments/service");
    const startsAt = weekdayAt(2, 7, 0); // 11:00 in Dubai
    const key = flowStepKey(run.id, 7);
    // The first attempt booked (key stored with it) and stopped before the confirmation.
    const booked = (
      await c.query<{ id: string }>(
        "select (public.book_appointment_for_flow_step($1, $2, $3, $4, $5, $6, $7, $8, $9, 'awaiting', null, false, 'bot', null, true)).id as id",
        [
          key,
          org,
          contact,
          clinic.loc,
          clinic.spec,
          clinic.svc,
          clinic.dept,
          startsAt.toISOString(),
          new Date(startsAt.getTime() + 30 * 60_000).toISOString(),
        ],
      )
    ).rows[0]!.id;
    const replay = () =>
      createAppointment(admin, {
        orgId: org,
        actorId: null,
        contactId: contact,
        locationId: clinic.loc,
        specialistId: clinic.spec,
        serviceId: clinic.svc,
        startsAt,
        notify: true,
        source: "bot",
        flowStepKey: key,
      });
    const r1 = await replay();
    const r2 = await replay();
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.appointment.id).toBe(booked);
    expect(r2.appointment.id).toBe(booked);
    expect(
      await count("select count(*)::int as n from public.messages where flow_step_key = $1", [key]),
    ).toBe(1);
  });
});
