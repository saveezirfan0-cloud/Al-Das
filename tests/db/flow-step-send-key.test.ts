/**
 * Replay-safe flow sends (migration 20261122000100_flow_step_send_key.sql, docs/23_PHASE_20B_NOTES.md).
 *   - messages.flow_step_key is unique when set: a second row with the same key is refused (23505), rows without a key are
 *     unaffected
 *   - outbound_message_enqueued() sees a job waiting in either outbound queue, and only the service role may call it
 *   - through PostgREST (when TEST_POSTGREST_URL / TEST_SERVICE_JWT are set): the real flow send adapter called twice with
 *     the same step key (a replayed step) returns the same message and leaves exactly one row and one outbound job
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

describe.skipIf(!TEST_DATABASE_URL)("messages.flow_step_key", () => {
  let c: Client;
  let org: string;
  let conv: string;

  const one = async (sql: string, params: unknown[]) =>
    (await c.query<{ id: string }>(sql + " returning id", params)).rows[0]!.id;
  const insertMessage = (key: string | null) =>
    one(
      "insert into public.messages (org_id, conversation_id, direction, kind, body, status, flow_step_key) values ($1, $2, 'out', 'text', 'Hello', 'queued', $3)",
      [org, conv, key],
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    const user = await createAuthUser(c, "flowkey-owner@example.test");
    org = await createOrg(c, "Flow Key Org", "flow-key-org", user);
    const channel = await one(
      "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'Main', 'WABA-FK', '109900000000071')",
      [org],
    );
    const contact = await one(
      "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Layla', 'Demo-07', '+447700900071')",
      [org],
    );
    conv = await one(
      "insert into public.conversations (org_id, channel_id, contact_id, last_inbound_at) values ($1, $2, $3, now())",
      [org, channel, contact],
    );
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("refuses a second message with the same step key", async () => {
    await insertMessage("00000000-0000-4000-8000-0000000000a1:2");
    await expect(insertMessage("00000000-0000-4000-8000-0000000000a1:2")).rejects.toMatchObject({
      code: "23505",
      constraint: "messages_flow_step_key_uidx",
    });
    const { rows } = await c.query(
      "select count(*)::int as n from public.messages where flow_step_key = $1",
      ["00000000-0000-4000-8000-0000000000a1:2"],
    );
    expect(rows[0].n).toBe(1);
  });

  it("accepts another step's key and any number of messages without a key", async () => {
    await insertMessage("00000000-0000-4000-8000-0000000000a1:3");
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

  it("outbound_message_enqueued sees a waiting job in either outbound queue", async () => {
    const a = await insertMessage("00000000-0000-4000-8000-0000000000a2:2");
    const b = await insertMessage("00000000-0000-4000-8000-0000000000a2:3");
    const check = async (id: string) =>
      (await c.query<{ v: boolean }>("select public.outbound_message_enqueued($1) as v", [id]))
        .rows[0]!.v;
    expect(await check(a)).toBe(false);
    await c.query("select pgmq.send('outbound', jsonb_build_object('message_id', $1::text))", [a]);
    await c.query(
      "select pgmq.send('outbound_priority', jsonb_build_object('message_id', $1::text))",
      [b],
    );
    expect(await check(a)).toBe(true);
    expect(await check(b)).toBe(true);
    await c.query("delete from pgmq.q_outbound");
    expect(await check(a)).toBe(false);
  });

  it("outbound_message_enqueued is for the service role only", async () => {
    const { rows } = await c.query<{
      anon: boolean;
      auth: boolean;
      svc: boolean;
      definer: boolean;
    }>(
      `select has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc,
              p.prosecdef as definer
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'outbound_message_enqueued'`,
    );
    expect(rows).toEqual([{ anon: false, auth: false, svc: true, definer: true }]);
  });
});

describe.skipIf(!viaRest)("flow send adapter replay through PostgREST", () => {
  let c: Client;
  let admin: AdminClient;
  let run: RunRecord;

  const one = async (sql: string, params: unknown[]) =>
    (await c.query<{ id: string }>(sql + " returning id", params)).rows[0]!.id;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    const user = await createAuthUser(c, "flowkey-rest@example.test");
    const org = await createOrg(c, "Flow Key Rest", "flow-key-rest", user);
    const channel = await one(
      "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'Main', 'WABA-FR', '109900000000072')",
      [org],
    );
    const contact = await one(
      "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Omar', 'Demo-08', '+447700900072')",
      [org],
    );
    const conv = await one(
      "insert into public.conversations (org_id, channel_id, contact_id, last_inbound_at) values ($1, $2, $3, now())",
      [org, channel, contact],
    );
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
    const jobs = await c.query(
      "select count(*)::int as n from pgmq.q_outbound where message ->> 'message_id' = $1",
      [first.messageId],
    );
    expect(jobs.rows[0].n).toBe(1);

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
    await actions.send(run, { type: "text", body: "Lost" }, "Lost", { stepKey: key });
    await actions.send(run, { type: "text", body: "Lost" }, "Lost", { stepKey: key });
    const jobs = await c.query(
      "select count(*)::int as n from pgmq.q_outbound where message ->> 'message_id' = $1",
      [first.messageId],
    );
    expect(jobs.rows[0].n).toBe(1);
    const rows = await c.query(
      "select count(*)::int as n from public.messages where flow_step_key = $1",
      [key],
    );
    expect(rows.rows[0].n).toBe(1);
  });
});
