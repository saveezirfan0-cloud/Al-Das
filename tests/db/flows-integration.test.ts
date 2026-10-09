/**
 * The real adapters (supabase-js through PostgREST) driving the flow engine and the recall engine end to end
 * against the plain-Postgres test database. Runs only with TEST_DATABASE_URL + TEST_POSTGREST_URL + TEST_SERVICE_JWT
 * (see supabase/test/README.md). Fake data only.
 */
import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

import { connect, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;
const enabled = Boolean(TEST_DATABASE_URL && POSTGREST_URL && SERVICE_JWT);

if (enabled) {
  // createAdminClient() (used by lib/jobs/enqueue) reads these on first use.
  process.env.NEXT_PUBLIC_SUPABASE_URL = POSTGREST_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
  process.env.JOB_SECRET = "test-job-secret-0123456789abcdef";
}

describe.skipIf(!enabled)("flows + recall with the real adapters", () => {
  let c: Client;
  let admin: AdminClient;
  let org: string;
  let user: string;
  let channel: string;
  let contact: string;
  let conv: string;
  let flow: string;
  let template: string;
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await c.query(sql, params)).rows as T[];
  const one = async (sql: string, params: unknown[] = []) =>
    (await q<{ id: string }>(sql + " returning id", params))[0]!.id;
  const modules = async () => ({
    run: await import("@/lib/flow-engine/run"),
    deps: await import("@/lib/flow-engine/supabase-deps"),
    triggers: await import("@/lib/flow-engine/triggers"),
    takeover: await import("@/lib/flow-engine/takeover"),
  });

  const GRAPH = {
    nodes: [
      { id: "t", type: "trigger", position: { x: 0, y: 0 }, data: {} },
      {
        id: "m",
        type: "message",
        position: { x: 1, y: 0 },
        data: { text: "Hi {contact.first_name}" },
      },
      {
        id: "q",
        type: "question",
        position: { x: 2, y: 0 },
        data: {
          text: "Book?",
          style: "buttons",
          options: [
            { id: "yes", title: "Yes" },
            { id: "no", title: "No" },
          ],
          variable: "answer",
        },
      },
      {
        id: "c",
        type: "add_comment",
        position: { x: 3, y: 0 },
        data: { text: "answer={vars.answer}" },
      },
      { id: "e", type: "end_flow", position: { x: 4, y: 0 }, data: {} },
    ],
    edges: [
      { id: "1", source: "t", target: "m", sourceHandle: "default" },
      { id: "2", source: "m", target: "q", sourceHandle: "default" },
      { id: "3", source: "q", target: "c", sourceHandle: "option:yes" },
      { id: "4", source: "q", target: "e", sourceHandle: "option:no" },
      { id: "5", source: "c", target: "e", sourceHandle: "default" },
    ],
  };

  async function drain(runId: string, max = 50) {
    const { run, deps } = await modules();
    const d = deps.createFlowDeps(admin);
    for (let i = 0; i < max; i++) {
      const [r] = await q<{ status: string }>("select status from public.flow_runs where id = $1", [
        runId,
      ]);
      if (r!.status !== "running") return r!.status;
      await run.advance(d, runId);
    }
    throw new Error("run did not settle");
  }

  async function newContact(first: string, phone: string, extra: Record<string, unknown> = {}) {
    return one(
      "insert into public.contacts (org_id, first_name, phone_e164, promotions_opt_in, external_id, dob, gender) values ($1, $2, $3, true, $4, $5, $6)",
      [
        org,
        first,
        phone,
        (extra.pin as string) ?? null,
        (extra.dob as string) ?? null,
        (extra.gender as string) ?? null,
      ],
    );
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
      auth: { persistSession: false },
    });
    user = await createAuthUser(c, "owner@example.test");
    org = await createOrg(c, "Org", "org-int", user);
    channel = await one(
      "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'Main', 'waba', 'pn-int')",
      [org],
    );
    contact = await newContact("Sara", "+971500000011", { pin: "PIN-A" });
    conv = await one(
      "insert into public.conversations (org_id, channel_id, contact_id, last_inbound_at) values ($1, $2, $3, now())",
      [org, channel, contact],
    );
    template = await one(
      `insert into public.wa_templates (org_id, waba_id, name, language, category, status, components)
       values ($1, 'waba', 'birthday_wish', 'en', 'MARKETING', 'APPROVED', '[{"type":"BODY","text":"Happy birthday {{1}}!"}]'::jsonb)`,
      [org],
    );
    flow = await one(
      `insert into public.flows (org_id, name, trigger_type, status, version, graph, published_graph) values ($1, 'Booking', 'shortcut', 'active', 1, $2, $2)`,
      [org, JSON.stringify(GRAPH)],
    );
    await q(
      "insert into public.flow_versions (flow_id, version, org_id, graph) values ($1, 1, $2, $3)",
      [flow, org, JSON.stringify(GRAPH)],
    );
    await q(
      "insert into public.flow_variables (org_id, key, value) values ($1, 'CLINIC', 'Al Das')",
      [org],
    );
  });

  afterAll(async () => {
    await c.end();
  });

  describe("flow engine", () => {
    it("runs a flow through the queue adapters, waits for the answer and resumes from the inbound message", async () => {
      const { run, deps, triggers } = await modules();
      const d = deps.createFlowDeps(admin);
      const started = await run.startRun(d, {
        flowId: flow,
        contactId: contact,
        conversationId: conv,
      });
      expect(started.started).toBe(true);
      const runId = (started as { runId: string }).runId;
      expect(
        (
          await q("select bot_active, flow_run_id from public.conversations where id = $1", [conv])
        )[0],
      ).toMatchObject({ bot_active: true, flow_run_id: runId });
      expect(await q("select 1 from pgmq.q_flow_steps")).toHaveLength(1);

      expect(await drain(runId)).toBe("waiting");
      const msgs = await q<{ body: string; status: string; flow_run_id: string; kind: string }>(
        "select body, status, flow_run_id, kind from public.messages where conversation_id = $1 and direction = 'out' order by at",
        [conv],
      );
      expect(msgs.map((m) => m.kind)).toEqual(["text", "interactive"]);
      expect(msgs[0]).toMatchObject({ body: "Hi Sara", status: "queued", flow_run_id: runId });
      expect(await q("select 1 from pgmq.q_outbound")).toHaveLength(2); // automation traffic uses the bulk outbound queue
      expect(
        (await q("select status, waiting_for from public.flow_runs where id = $1", [runId]))[0],
      ).toMatchObject({ status: "waiting" });

      // A second flow cannot start while this one owns the conversation.
      expect(
        await run.startRun(d, { flowId: flow, contactId: contact, conversationId: conv }),
      ).toEqual({ started: false, reason: "live_run_exists" });

      // The patient taps "Yes": an inbound interactive message → trigger job logic → resume.
      const inbound = await one(
        `insert into public.messages (org_id, conversation_id, direction, kind, body, payload, status, wa_message_id)
         values ($1, $2, 'in', 'interactive', 'Yes', '{"interactive":{"type":"button_reply","button_reply":{"id":"yes","title":"Yes"}}}'::jsonb, 'received', 'wamid.int.1')`,
        [org, conv],
      );
      const out = await triggers.handleTriggerEvent(d, {
        orgId: org,
        name: "message.received",
        payload: { message_id: inbound, conversation_id: conv, contact_id: contact },
      });
      expect(out.resumed).toBe(true);
      expect(await drain(runId)).toBe("completed");
      const note = await q<{ body: string; direction: string }>(
        "select body, direction from public.messages where conversation_id = $1 and direction = 'note'",
        [conv],
      );
      expect(note).toEqual([{ body: "answer=Yes", direction: "note" }]);
      expect(
        (
          await q("select bot_active, flow_run_id from public.conversations where id = $1", [conv])
        )[0],
      ).toMatchObject({ bot_active: false, flow_run_id: null });
      const steps = await q<{ node_id: string; status: string }>(
        "select node_id, status from public.flow_run_steps where run_id = $1 order by seq",
        [runId],
      );
      expect(steps.map((s) => [s.node_id, s.status])).toEqual([
        ["t", "ok"],
        ["m", "ok"],
        ["q", "ok"],
        ["c", "ok"],
        ["e", "ok"],
      ]);
      expect(await q("select * from public.flow_locks")).toHaveLength(0); // every lease released
    });

    it("human takeover cancels a waiting run and frees the conversation", async () => {
      const { run, deps, takeover } = await modules();
      const d = deps.createFlowDeps(admin);
      const s = (await run.startRun(d, {
        flowId: flow,
        contactId: contact,
        conversationId: conv,
      })) as { runId: string };
      expect(await drain(s.runId)).toBe("waiting");
      expect(await takeover.takeOverFromBot(admin, conv, "Agent took over")).toBe(true);
      expect(
        (await q("select status, error from public.flow_runs where id = $1", [s.runId]))[0],
      ).toMatchObject({ status: "cancelled", error: "Agent took over" });
      expect(
        (await q("select bot_active from public.conversations where id = $1", [conv]))[0],
      ).toMatchObject({ bot_active: false });
    });

    it("waits through scheduled_jobs and resumes with the token", async () => {
      const { run, deps } = await modules();
      const d = deps.createFlowDeps(admin);
      const g = {
        nodes: [
          { id: "t", type: "trigger", position: { x: 0, y: 0 }, data: {} },
          { id: "w", type: "wait", position: { x: 1, y: 0 }, data: { amount: 2, unit: "hours" } },
          { id: "c", type: "add_comment", position: { x: 2, y: 0 }, data: { text: "after wait" } },
        ],
        edges: [
          { id: "1", source: "t", target: "w", sourceHandle: "default" },
          { id: "2", source: "w", target: "c", sourceHandle: "default" },
        ],
      };
      const f = await one(
        `insert into public.flows (org_id, name, trigger_type, status, version, graph, published_graph) values ($1, 'Waiter', 'shortcut', 'active', 1, $2, $2)`,
        [org, JSON.stringify(g)],
      );
      await q(
        "insert into public.flow_versions (flow_id, version, org_id, graph) values ($1, 1, $2, $3)",
        [f, org, JSON.stringify(g)],
      );
      const s = (await run.startRun(d, {
        flowId: f,
        contactId: contact,
        conversationId: conv,
      })) as { runId: string };
      expect(await drain(s.runId)).toBe("waiting");
      const jobs = await q<{
        kind: string;
        payload: { run_id: string; token: string };
        run_at: string;
        dedupe_key: string;
      }>(
        "select kind, payload, run_at, dedupe_key from public.scheduled_jobs where kind = 'flow.resume' and payload->>'run_id' = $1",
        [s.runId],
      );
      expect(jobs).toHaveLength(1);
      expect(new Date(jobs[0]!.run_at).getTime()).toBeGreaterThan(Date.now() + 100 * 60_000);
      expect(await run.resumeFromTimer(d, s.runId, "stale")).toEqual({
        resumed: false,
        reason: "stale_token",
      });
      expect(await run.resumeFromTimer(d, s.runId, jobs[0]!.payload.token)).toEqual({
        resumed: true,
      });
      expect(await drain(s.runId)).toBe("completed");
    });

    it("conversation_opened flows match on Keyword and Ad conditions", async () => {
      const { deps, triggers } = await modules();
      const d = deps.createFlowDeps(admin);
      const g = {
        nodes: [
          { id: "t", type: "trigger", position: { x: 0, y: 0 }, data: {} },
          { id: "c", type: "add_comment", position: { x: 1, y: 0 }, data: { text: "routed" } },
        ],
        edges: [{ id: "1", source: "t", target: "c", sourceHandle: "default" }],
      };
      const cfg = {
        conditions: {
          logic: "and",
          conditions: [{ category: "keyword", op: "contains", value: "check up" }],
        },
      };
      const f = await one(
        `insert into public.flows (org_id, name, trigger_type, trigger_config, status, version, graph, published_graph) values ($1, 'Keyword', 'conversation_opened', $2, 'active', 1, $3, $3)`,
        [org, JSON.stringify(cfg), JSON.stringify(g)],
      );
      await q(
        "insert into public.flow_versions (flow_id, version, org_id, graph) values ($1, 1, $2, $3)",
        [f, org, JSON.stringify(g)],
      );
      const contact2 = await newContact("Omar", "+971500000012");
      const conv2 = await one(
        "insert into public.conversations (org_id, channel_id, contact_id, last_inbound_at) values ($1, $2, $3, now())",
        [org, channel, contact2],
      );
      await q(
        "insert into public.messages (org_id, conversation_id, direction, kind, body, status, wa_message_id) values ($1, $2, 'in', 'text', 'Hello, I want a Check Up', 'received', 'wamid.int.2')",
        [org, conv2],
      );
      const hit = await triggers.handleTriggerEvent(d, {
        orgId: org,
        name: "conversation.opened",
        payload: { conversation_id: conv2, contact_id: contact2 },
      });
      expect(hit.started).toHaveLength(1);

      const contact3 = await newContact("Lina", "+971500000013");
      const conv3 = await one(
        "insert into public.conversations (org_id, channel_id, contact_id, last_inbound_at) values ($1, $2, $3, now())",
        [org, channel, contact3],
      );
      await q(
        "insert into public.messages (org_id, conversation_id, direction, kind, body, status, wa_message_id) values ($1, $2, 'in', 'text', 'what are your hours', 'received', 'wamid.int.3')",
        [org, conv3],
      );
      const miss = await triggers.handleTriggerEvent(d, {
        orgId: org,
        name: "conversation.opened",
        payload: { conversation_id: conv3, contact_id: contact3 },
      });
      expect(miss.started).toHaveLength(0);
    });

    it("recurring flows fire once per matching minute (atomic claim)", async () => {
      await import("@/lib/jobs/handlers/flow-recurring");
      const { getTask } = await import("@/lib/jobs/tasks");
      const g = {
        nodes: [
          { id: "t", type: "trigger", position: { x: 0, y: 0 }, data: {} },
          {
            id: "n",
            type: "send_notification",
            position: { x: 1, y: 0 },
            data: { target: { type: "role", id: "Admin" }, title: "Tick", body: "" },
          },
        ],
        edges: [{ id: "1", source: "t", target: "n", sourceHandle: "default" }],
      };
      const f = await one(
        `insert into public.flows (org_id, name, trigger_type, trigger_config, status, version, graph, published_graph) values ($1, 'Every minute', 'recurring', '{"cron":"* * * * *"}', 'active', 1, $2, $2)`,
        [org, JSON.stringify(g)],
      );
      await q(
        "insert into public.flow_versions (flow_id, version, org_id, graph) values ($1, 1, $2, $3)",
        [f, org, JSON.stringify(g)],
      );
      const task = getTask("flow_recurring")!;
      const log = { info() {}, warn() {}, error() {} };
      expect(await task.run(admin, log as never)).toMatchObject({ fired: 1, runs: 1 });
      expect(await task.run(admin, log as never)).toMatchObject({ fired: 0, runs: 0 });
      expect(await q("select 1 from public.flow_runs where flow_id = $1", [f])).toHaveLength(1);
    });

    it("the incoming-webhook route authenticates by token, creates the contact and starts the run", async () => {
      const { NextRequest } = await import("next/server");
      const { POST } = await import("@/app/api/webhooks/in/[flowId]/route");
      const { newWebhookToken } = await import("@/lib/flow-engine/webhook-token");
      const { token, hash } = newWebhookToken();
      const g = {
        nodes: [
          { id: "t", type: "trigger", position: { x: 0, y: 0 }, data: {} },
          { id: "c", type: "add_comment", position: { x: 1, y: 0 }, data: { text: "x" } },
        ],
        edges: [{ id: "1", source: "t", target: "c", sourceHandle: "default" }],
      };
      const f = await one(
        `insert into public.flows (org_id, name, trigger_type, trigger_config, status, version, graph, published_graph) values ($1, 'Hook', 'webhook', $2, 'active', 1, $3, $3)`,
        [org, JSON.stringify({ webhook_token_hash: hash }), JSON.stringify(g)],
      );
      await q(
        "insert into public.flow_versions (flow_id, version, org_id, graph) values ($1, 1, $2, $3)",
        [f, org, JSON.stringify(g)],
      );
      const call = (auth: string | null, body: unknown) =>
        POST(
          new NextRequest(`http://localhost/api/webhooks/in/${f}`, {
            method: "POST",
            headers: auth ? { authorization: `Bearer ${auth}` } : {},
            body: JSON.stringify(body),
          }),
          { params: Promise.resolve({ flowId: f }) },
        );
      expect((await call(null, { phone: "+971500000099" })).status).toBe(401);
      expect((await call("wrong", { phone: "+971500000099" })).status).toBe(401);
      expect((await call(token, { first_name: "no phone" })).status).toBe(400);
      const ok = await call(token, {
        phone: "050 000 0099",
        first_name: "Hook",
        data: { source: "form" },
      });
      expect(ok.status).toBe(202);
      const body = (await ok.json()) as { run_id: string };
      expect(
        await q("select contact_id from public.flow_runs where id = $1", [body.run_id]),
      ).toHaveLength(1);
      expect(
        (
          await q(
            "select phone_e164, source from public.contacts where org_id = $1 and phone_e164 = '+971500000099'",
            [org],
          )
        )[0],
      ).toMatchObject({ source: "api" });
    });
  });

  describe("recall engine", () => {
    let programme: string;
    const today = async () =>
      (
        await q<{ d: string }>(
          "select to_char((now() at time zone 'Asia/Dubai')::date, 'YYYY-MM-DD') as d",
        )
      )[0]!.d;

    beforeAll(async () => {
      await q("select public.seed_phase8_defaults($1)", [org]);
      programme = (
        await q<{ id: string }>(
          "select id from public.recall_programmes where org_id = $1 and key = 'birthday'",
          [org],
        )
      )[0]!.id;
      await q(
        "update public.recall_programme_templates set wa_template_id = $2 where programme_id = $1 and segment_key in ('f_18_35','m_30_39')",
        [programme, template],
      );
      await q("update public.recall_programmes set status = 'active' where id = $1", [programme]);
      // three birthday patients today (two covered bands, one uncovered)
      const d = await today();
      const [yy, mm, dd] = d.split("-").map(Number) as [number, number, number];
      for (const [name, phone, gender, age, pin] of [
        ["Fatima", "+971500000021", "female", 30, "PIN-F"],
        ["Khaled", "+971500000022", "male", 35, "PIN-K"],
        ["Young", "+971500000023", "male", 12, "PIN-Y"],
      ] as const) {
        await newContact(name, phone, {
          pin,
          dob: `${yy - age}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`,
          gender,
        });
      }
    });

    it("is blocked in Test mode until test numbers are signed off; nothing is recorded", async () => {
      const { runProgramme } = await import("@/lib/recall/engine");
      const { createRecallDeps } = await import("@/lib/recall/supabase-deps");
      const r = await runProgramme(createRecallDeps(admin), programme);
      expect(r).toMatchObject({ mode: "test", blocked: "no_test_recipients" });
      expect(
        await q("select 1 from public.recall_sends where programme_id = $1", [programme]),
      ).toHaveLength(0);
    });

    it("Test mode messages only the internal test numbers, records every eligible patient and skips uncovered bands", async () => {
      const { runProgramme } = await import("@/lib/recall/engine");
      const { createRecallDeps } = await import("@/lib/recall/supabase-deps");
      await q(
        "update public.clinical_settings set approved_value = '+971500000901, +971500000902', sign_off_status = 'approved', signed_by = 'Test', signed_at = current_date where org_id = $1 and key = 'test_recipient_numbers'",
        [org],
      );
      await q("delete from pgmq.q_outbound");
      const r = await runProgramme(createRecallDeps(admin), programme);
      expect(r).toMatchObject({
        mode: "test",
        listed: 3,
        queued: 2,
        skipped_no_template: 1,
        already_handled: 0,
      });
      const sends = await q<{
        status: string;
        segment_key: string | null;
        sent_to_phone_e164: string | null;
        send_mode: string;
      }>(
        "select status, segment_key, sent_to_phone_e164, send_mode from public.recall_sends where programme_id = $1 order by segment_key nulls first",
        [programme],
      );
      expect(sends.map((s) => s.status).sort()).toEqual([
        "queued",
        "queued",
        "skipped_no_template",
      ]);
      expect(sends.every((s) => s.send_mode === "test")).toBe(true);
      expect(
        sends
          .filter((s) => s.status === "queued")
          .every((s) => ["+971500000901", "+971500000902"].includes(s.sent_to_phone_e164!)),
      ).toBe(true);
      // The queued messages sit in conversations of is_test_record contacts, never the patients'.
      const targets = await q<{ is_test_record: boolean; phone_e164: string }>(
        `select c.is_test_record, c.phone_e164 from public.messages m join public.conversations v on v.id = m.conversation_id join public.contacts c on c.id = v.contact_id
         where m.kind = 'template' and m.direction = 'out'`,
      );
      expect(targets).toHaveLength(2);
      expect(targets.every((t) => t.is_test_record && t.phone_e164.startsWith("+9715000009"))).toBe(
        true,
      );
      expect(await q("select 1 from pgmq.q_outbound")).toHaveLength(2);
      // patient tag only in Live
      expect(
        await q("select 1 from public.tags where org_id = $1 and name like 'birthday_sent_%'", [
          org,
        ]),
      ).toHaveLength(0);
    });

    it("a second run the same day is idempotent", async () => {
      const { runProgramme } = await import("@/lib/recall/engine");
      const { createRecallDeps } = await import("@/lib/recall/supabase-deps");
      const r = await runProgramme(createRecallDeps(admin), programme);
      expect(r).toMatchObject({ queued: 0 });
      expect(
        await q("select 1 from public.recall_sends where programme_id = $1", [programme]),
      ).toHaveLength(3);
    });

    it("mirrors delivery status and attributes replies, button outcomes and bookings to the newest open send only", async () => {
      const { syncSendStatuses } = await import("@/lib/recall/sync");
      const { attributeBooking, attributeInboundReply } = await import("@/lib/recall/attribution");
      const queued = await q<{ id: string; message_id: string; contact_id: string }>(
        "select id, message_id, contact_id from public.recall_sends where programme_id = $1 and status = 'queued'",
        [programme],
      );
      // Deliver one message; the outbound handler would set messages.status.
      await q("update public.messages set status = 'delivered' where id = $1", [
        queued[0]!.message_id,
      ]);
      await q("update public.recall_sends set sent_at = now() - interval '2 days' where id = $1", [
        queued[0]!.id,
      ]);
      expect(await syncSendStatuses(admin)).toBeGreaterThanOrEqual(1);
      expect(
        (await q("select status from public.recall_sends where id = $1", [queued[0]!.id]))[0],
      ).toMatchObject({ status: "delivered" });

      // attribution is per real contact; make the first send belong to a patient with an older open send too
      const patient = queued[0]!.contact_id;
      const older = await one(
        `insert into public.recall_sends (org_id, programme_id, contact_id, cycle_key, status, sent_at) values ($1, $2, $3, 'older', 'sent', now() - interval '9 days')`,
        [org, programme, patient],
      );
      const msg = await one(
        "insert into public.messages (org_id, conversation_id, direction, kind, body, status, wa_message_id) values ($1, $2, 'in', 'button', 'Claim offer', 'received', 'wamid.int.btn')",
        [org, conv],
      );
      const r = await attributeInboundReply(admin, {
        orgId: org,
        contactId: patient,
        messageId: msg,
        body: "Claim offer",
        kind: "button",
      });
      expect(r).toEqual({ attributed: true, wantsBooking: false });
      expect(
        (
          await q(
            "select replied_at is not null as replied, outcome from public.recall_sends where id = $1",
            [queued[0]!.id],
          )
        )[0],
      ).toEqual({ replied: true, outcome: "offer_redeemed" });
      expect(
        (await q("select replied_at from public.recall_sends where id = $1", [older]))[0],
      ).toEqual({ replied_at: null }); // the older send is not credited

      expect(
        await attributeBooking(admin, { orgId: org, contactId: patient, appointmentId: null }),
      ).toBe(true);
      expect(
        (
          await q(
            "select follow_up_status, booked_at is not null as booked from public.recall_sends where id = $1",
            [queued[0]!.id],
          )
        )[0],
      ).toEqual({ follow_up_status: "booked", booked: true });
    });

    it("Live programmes message the patient themselves and tag them (programme override + gates)", async () => {
      const { runProgramme } = await import("@/lib/recall/engine");
      const { createRecallDeps } = await import("@/lib/recall/supabase-deps");
      const g = (
        await q<{ id: string }>(
          "select id from public.recall_programmes where org_id = $1 and key = 'birthday'",
          [org],
        )
      )[0]!.id;
      await q("update public.recall_programmes set send_mode_override = 'live' where id = $1", [g]);
      await q("delete from public.recall_sends where programme_id = $1", [g]);
      const r = await runProgramme(createRecallDeps(admin), g);
      expect(r).toMatchObject({ mode: "live", queued: 2, skipped_no_template: 1 });
      const sent = await q<{ is_test_record: boolean }>(
        `select c.is_test_record from public.recall_sends s join public.messages m on m.id = s.message_id join public.conversations v on v.id = m.conversation_id join public.contacts c on c.id = v.contact_id where s.programme_id = $1 and s.status = 'queued'`,
        [g],
      );
      expect(sent).toHaveLength(2);
      expect(sent.every((s) => !s.is_test_record)).toBe(true);
      const year = (await today()).slice(0, 4);
      expect(
        await q(
          "select 1 from public.contact_tags ct join public.tags t on t.id = ct.tag_id where t.name = $1",
          [`birthday_sent_${year}`],
        ),
      ).toHaveLength(2);
    });

    it("stop_marketing contacts are skipped, never messaged", async () => {
      const { runProgramme } = await import("@/lib/recall/engine");
      const { createRecallDeps } = await import("@/lib/recall/supabase-deps");
      const stopped = await newContact("Nora", "+971500000031", {
        pin: "PIN-N",
        dob: `1990-${(await today()).slice(5)}`,
        gender: "female",
      });
      await q("update public.contacts set stop_marketing = true where id = $1", [stopped]);
      const r = await runProgramme(createRecallDeps(admin), programme);
      expect(r.skipped_opted_out).toBe(0); // the view already excludes stop_marketing contacts
      expect(
        await q("select 1 from public.recall_sends where contact_id = $1", [stopped]),
      ).toHaveLength(0);
    });

    it("recall_run claims the programme per minute and the parallel run compares hashed ids only", async () => {
      await import("@/lib/jobs/handlers/recall-run");
      const { getTask } = await import("@/lib/jobs/tasks");
      const log = { info() {}, warn() {}, error() {} };
      await q(
        "update public.recall_programmes set cron_expression = '* * * * *', last_run_at = null where id = $1",
        [programme],
      );
      const task = getTask("recall_run")!;
      expect(await task.run(admin, log as never)).toMatchObject({ ran: 1 });
      expect(await task.run(admin, log as never)).toMatchObject({ ran: 0 });

      const { computeDiff } = await import("@/lib/parallel-run/service");
      const { makeOutputRows } = await import("@/lib/parallel-run/diff");
      const day = await today();
      // Make messaged PIN-F and PIN-K plus PIN-GHOST; native (Test mode) recorded PIN-F and PIN-K.
      const rows = makeOutputRows(org, "birthday", day, ["PIN-F", "PIN-K", "PIN-GHOST"]);
      await admin.from("parallel_run_make_outputs").upsert(rows);
      const d = await computeDiff(admin, org, "birthday", day);
      expect(d).toMatchObject({ make_count: 3, native_count: 2 });
      expect(d!.only_in_native).toEqual([]);
      expect(d!.only_in_make).toHaveLength(1);
      expect(d!.only_in_make[0]).toMatch(/^[0-9a-f]{64}$/); // a hash, never the PIN
      const stored = await q<{ only_in_make: string[] }>(
        "select only_in_make from public.parallel_run_diffs where org_id = $1 and scenario_key = 'birthday'",
        [org],
      );
      expect(JSON.stringify(stored)).not.toContain("PIN-GHOST");
    });
  });
});
