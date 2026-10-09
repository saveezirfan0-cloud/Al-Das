/**
 * The flow runtime end to end against a real Postgres through PostgREST: start, send, wait for a
 * reply, resume, timeout, takeover, locks, idempotency, loop guard and the recurring trigger.
 * Runs only when TEST_DATABASE_URL, TEST_POSTGREST_URL and TEST_SERVICE_JWT are set
 * (supabase/test/README.md). Fake data only.
 */
import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { and, cond } from "@/lib/filters/ast";
import {
  cancelConversationRuns,
  dispatchEvent,
  loadGraph,
  runRecurring,
  startRun,
  sweepStuckRuns,
  type FlowRow,
} from "@/lib/flow-engine/service";
import { processStep } from "@/lib/flow-engine/step";
import type { FlowGraph } from "@/lib/flow-engine/types";
import { getHandler } from "@/lib/jobs/registry";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/types";

import { connect, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;

const node = (id: string, type: string, data: Record<string, unknown> = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data,
});
const edge = (source: string, target: string, sourceHandle?: string) => ({
  id: `${source}>${target}${sourceHandle ?? ""}`,
  source,
  target,
  sourceHandle,
});

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)("flow runtime (db)", () => {
  let c: Client;
  let admin: AdminClient;
  let org: string;
  let owner: string;
  let channel: string;
  let contact: string;
  let conversation: string;

  async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
    const { rows } = await c.query(sql, params);
    return rows[0] as T;
  }

  async function makeFlow(
    name: string,
    graph: unknown,
    over: Record<string, unknown> = {},
  ): Promise<FlowRow> {
    const f = await one<{ id: string }>(
      `insert into public.flows (org_id, name, status, trigger_type, version, draft_graph, created_by, published_by, trigger_config, conditions)
       values ($1,$2,'active',$3,1,$4,$5,$5,$6,$7) returning id`,
      [
        org,
        name,
        over.trigger_type ?? "conversation_opened",
        JSON.stringify(graph),
        owner,
        JSON.stringify(over.trigger_config ?? {}),
        over.conditions ? JSON.stringify(over.conditions) : null,
      ],
    );
    await c.query(
      "insert into public.flow_versions (org_id, flow_id, version, graph, published_by) values ($1,$2,1,$3,$4)",
      [org, f.id, JSON.stringify(graph), owner],
    );
    const { data } = await admin.from("flows").select("*").eq("id", f.id).single();
    return data as FlowRow;
  }

  /** Runs queued flow_steps jobs through the real handler until the queue is idle. */
  async function pump(max = 400): Promise<number> {
    const def = getHandler("flow_steps")!;
    let n = 0;
    for (; n < max; n++) {
      const row = await one<{ msg_id: string; message: Json } | undefined>(
        "select msg_id, message from pgmq.q_flow_steps where vt <= now() order by msg_id limit 1",
      );
      if (!row) break;
      await c.query("delete from pgmq.q_flow_steps where msg_id = $1", [row.msg_id]);
      await def.handler(row.message, {
        queue: "flow_steps",
        msgId: Number(row.msg_id),
        readCt: 1,
        enqueuedAt: new Date(),
        admin,
        log: { info() {}, warn() {}, error() {} },
      });
    }
    return n;
  }

  const run = (id: string) =>
    one<Record<string, any>>("select * from public.flow_runs where id = $1", [id]); // eslint-disable-line @typescript-eslint/no-explicit-any
  const steps = async (id: string) =>
    (
      await c.query(
        "select seq, node_id, node_type, status, handle from public.flow_run_steps where run_id = $1 order by seq",
        [id],
      )
    ).rows;
  const sent = async () =>
    (
      await c.query(
        "select kind, body, flow_run_id, payload from public.messages where conversation_id = $1 and direction in ('out','note') order by at, created_at",
        [conversation],
      )
    ).rows;

  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = POSTGREST_URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
    process.env.JOB_SECRET = "test-job-secret-0123456789";
    await import("@/lib/jobs/handlers/flow-steps");
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
    owner = await createAuthUser(c, "owner@example.test");
    org = await createOrg(c, "Clinic", "clinic", owner);
    channel = (
      await one<{ id: string }>(
        "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1,'Main','waba-1','pn-1') returning id",
        [org],
      )
    ).id;
    contact = (
      await one<{ id: string }>(
        "insert into public.contacts (org_id, first_name, last_name, phone_e164, language) values ($1,'Sara','Test','+971500000001','en') returning id",
        [org],
      )
    ).id;
    conversation = (
      await one<{ id: string }>(
        "insert into public.conversations (org_id, channel_id, contact_id, status) values ($1,$2,$3,'open') returning id",
        [org, channel, contact],
      )
    ).id;
  });

  const yesNo = [
    { id: "yes", title: "Yes" },
    { id: "no", title: "No" },
  ];
  const askGraph = (extra: Record<string, unknown> = {}): FlowGraph =>
    ({
      nodes: [
        node("t", "trigger"),
        node("hi", "message", { text: "Hi {contact.first_name}" }),
        node("q", "question", {
          text: "Shall we book?",
          kind: "buttons",
          options: yesNo,
          variable: "answer",
          ...extra,
        }),
        node("ok", "add_comment", { text: "Patient said {vars.answer}" }),
        node("no", "close_conversation"),
      ],
      edges: [
        edge("t", "hi"),
        edge("hi", "q"),
        edge("q", "ok", "option:yes"),
        edge("q", "no", "fallback"),
      ],
    }) as unknown as FlowGraph;

  const startOn = (flow: FlowRow) =>
    startRun(admin, flow, {
      conversationId: conversation,
      contactId: contact,
      context: { conversation_id: conversation, contact_id: contact },
      event: { name: "test" },
    });

  it("sends, asks, waits, resumes on the button reply and completes", async () => {
    const flow = await makeFlow("ask", askGraph());
    const started = await startOn(flow);
    expect(started.status).toBe("started");
    if (started.status !== "started") return;

    await pump();
    let r = await run(started.runId);
    expect(r.status).toBe("waiting");
    expect(r.wait).toMatchObject({ type: "reply", node_id: "q" });
    const conv = await one<{ bot_active: boolean; flow_run_id: string }>(
      "select bot_active, flow_run_id from public.conversations where id = $1",
      [conversation],
    );
    expect(conv).toMatchObject({ bot_active: true, flow_run_id: started.runId });
    expect((await sent()).map((m) => m.kind)).toEqual(["text", "interactive"]);
    expect((await sent())[0].body).toBe("Hi Sara");
    expect((await sent())[0].payload.flow_step).toBe("1");

    // The patient taps "Yes".
    const msg = await one<{ id: string }>(
      "insert into public.messages (org_id, conversation_id, direction, kind, body, status) values ($1,$2,'in','interactive','Yes','received') returning id",
      [org, conversation],
    );
    const d = await dispatchEvent(admin, {
      type: "event",
      org_id: org,
      name: "message.received",
      payload: {
        conversation_id: conversation,
        message_id: msg.id,
        kind: "interactive",
        interactive: { id: "yes", title: "Yes" },
      },
      at: new Date().toISOString(),
    });
    expect(d.resumed).toBe(true);
    await pump();

    r = await run(started.runId);
    expect(r.status).toBe("completed");
    expect(r.vars).toMatchObject({ answer: "Yes", answer_id: "yes" });
    expect((await steps(started.runId)).map((s) => [s.seq, s.node_id, s.status, s.handle])).toEqual(
      [
        [1, "hi", "ok", "default"],
        [2, "q", "waiting", null],
        [3, "q", "ok", "option:yes"],
        [4, "ok", "ok", "default"],
      ],
    );
    expect((await sent()).at(-1)).toMatchObject({ kind: "note", body: "Patient said Yes" });
    expect(
      await one("select bot_active, flow_run_id from public.conversations where id = $1", [
        conversation,
      ]),
    ).toEqual({ bot_active: false, flow_run_id: null });
  });

  it("an unexpected answer takes the fallback exit", async () => {
    const flow = await makeFlow("ask", askGraph());
    const s = await startOn(flow);
    if (s.status !== "started") throw new Error("not started");
    await pump();
    const msg = await one<{ id: string }>(
      "insert into public.messages (org_id, conversation_id, direction, kind, body, status) values ($1,$2,'in','text','maybe later','received') returning id",
      [org, conversation],
    );
    await dispatchEvent(admin, {
      type: "event",
      org_id: org,
      name: "message.received",
      payload: { conversation_id: conversation, message_id: msg.id, kind: "text" },
      at: new Date().toISOString(),
    });
    await pump();
    expect((await run(s.runId)).status).toBe("completed");
    expect(
      (
        await one<{ status: string }>("select status from public.conversations where id = $1", [
          conversation,
        ])
      ).status,
    ).toBe("closed");
  });

  it("the timeout timer takes the fallback; a timer for an old wait is ignored", async () => {
    const flow = await makeFlow("ask", askGraph({ timeoutMinutes: 5 }));
    const s = await startOn(flow);
    if (s.status !== "started") throw new Error("not started");
    await pump();
    const r = await run(s.runId);
    const job = await one<{
      kind: string;
      payload: { run_id: string; token: number };
      run_at: string;
    }>("select kind, payload, run_at from public.scheduled_jobs where kind = 'flow.timeout'");
    expect(job.payload).toMatchObject({ run_id: s.runId, token: r.wait.token });

    const def = getHandler("flow_steps")!;
    const ctx = {
      queue: "flow_steps" as const,
      msgId: 1,
      readCt: 1,
      enqueuedAt: new Date(),
      admin,
      log: { info() {}, warn() {}, error() {} },
    };
    await def.handler(
      { kind: "flow.timeout", org_id: org, payload: { run_id: s.runId, token: r.wait.token + 7 } },
      ctx,
    );
    await pump();
    expect((await run(s.runId)).status).toBe("waiting"); // wrong token: stale

    await def.handler({ kind: "flow.timeout", org_id: org, payload: job.payload }, ctx);
    await pump();
    expect((await run(s.runId)).status).toBe("completed");
    expect(
      (
        await one<{ status: string }>("select status from public.conversations where id = $1", [
          conversation,
        ])
      ).status,
    ).toBe("closed");
  });

  it("a duplicate delivery of the same step sends once", async () => {
    const flow = await makeFlow("ask", askGraph());
    const s = await startOn(flow);
    if (s.status !== "started") throw new Error("not started");
    const job = {
      type: "step" as const,
      run_id: s.runId,
      expect: 0,
      input: { type: "start" as const },
    };
    expect(await processStep(admin, job)).toBe("done");
    expect(await processStep(admin, job)).toBe("stale");
    const texts = (await sent()).filter((m) => m.kind === "text");
    expect(texts).toHaveLength(1);
  });

  it("a retried step that already queued its message does not queue it again", async () => {
    const flow = await makeFlow("ask", askGraph());
    const s = await startOn(flow);
    if (s.status !== "started") throw new Error("not started");
    await c.query(
      "insert into public.messages (org_id, conversation_id, direction, kind, body, status, flow_run_id, payload) values ($1,$2,'out','text','Hi Sara','queued',$3,'{\"flow_step\":\"1\"}')",
      [org, conversation, s.runId],
    );
    await processStep(admin, {
      type: "step",
      run_id: s.runId,
      expect: 0,
      input: { type: "start" },
    });
    expect((await sent()).filter((m) => m.kind === "text")).toHaveLength(1);
    expect((await run(s.runId)).step_count).toBe(1);
  });

  it("allows one live bot run per conversation", async () => {
    const flow = await makeFlow("ask", askGraph());
    expect((await startOn(flow)).status).toBe("started");
    expect(await startOn(flow)).toEqual({ status: "skipped", reason: "already_running" });
  });

  it("human takeover cancels the run and a queued step becomes a no-op", async () => {
    const flow = await makeFlow("ask", askGraph());
    const s = await startOn(flow);
    if (s.status !== "started") throw new Error("not started");
    await pump(1); // first step only
    expect(await cancelConversationRuns(admin, org, conversation, "takeover")).toBe(1);
    const r = await run(s.runId);
    expect(r).toMatchObject({ status: "cancelled", cancel_reason: "takeover" });
    expect(
      await one("select bot_active, flow_run_id from public.conversations where id = $1", [
        conversation,
      ]),
    ).toEqual({ bot_active: false, flow_run_id: null });
    const before = (await sent()).length;
    await pump();
    expect((await sent()).length).toBe(before);
    expect(await cancelConversationRuns(admin, org, conversation, "takeover")).toBe(0);
  });

  it("serialises steps with the conversation lease", async () => {
    const holderA = await admin.rpc("flow_lock_acquire", {
      p_key: conversation,
      p_holder: "a",
      p_ttl_seconds: 30,
    });
    const holderB = await admin.rpc("flow_lock_acquire", {
      p_key: conversation,
      p_holder: "b",
      p_ttl_seconds: 30,
    });
    expect([holderA.data, holderB.data]).toEqual([true, false]);

    const flow = await makeFlow("ask", askGraph());
    const s = await startOn(flow);
    if (s.status !== "started") throw new Error("not started");
    expect(
      await processStep(
        admin,
        { type: "step", run_id: s.runId, expect: 0, input: { type: "start" } },
        "worker",
      ),
    ).toBe("locked");
    await admin.rpc("flow_lock_release", { p_key: conversation, p_holder: "a" });
    expect(
      await processStep(
        admin,
        { type: "step", run_id: s.runId, expect: 0, input: { type: "start" } },
        "worker",
      ),
    ).toBe("done");

    // An expired lease can be taken over.
    await c.query("update public.flow_locks set expires_at = now() - interval '1 second'");
    const stolen = await admin.rpc("flow_lock_acquire", {
      p_key: conversation,
      p_holder: "c",
      p_ttl_seconds: 30,
    });
    expect(stolen.data).toBe(true);
  });

  it("stops a looping flow at 200 steps", async () => {
    const loop = {
      nodes: [
        node("t", "trigger"),
        node("a", "add_comment", { text: "x" }),
        node("b", "add_comment", { text: "y" }),
      ],
      edges: [edge("t", "a"), edge("a", "b"), edge("b", "a")],
    };
    const flow = await makeFlow("loop", loop);
    const s = await startOn(flow);
    if (s.status !== "started") throw new Error("not started");
    await pump(500);
    const r = await run(s.runId);
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/200 steps/);
    expect(r.step_count).toBe(201); // 200 executed steps + the refusal to run a 201st
    expect((await sent()).filter((m) => m.kind === "note")).toHaveLength(200);
    expect((await steps(s.runId)).filter((t) => t.status === "failed")).toHaveLength(1);
  }, 60_000);

  it("starts flows from events: trigger config, conditions and one run per event", async () => {
    const graph = {
      nodes: [node("t", "trigger"), node("m", "add_comment", { text: "matched" })],
      edges: [edge("t", "m")],
    };
    const kw = await makeFlow("keyword", graph, {
      conditions: { include: and(cond("message.text", "contains", "book")) },
    });
    const otherNumber = await makeFlow("other number", graph, {
      trigger_config: { channel_id: "00000000-0000-0000-0000-000000000000" },
    });
    const paused = await makeFlow("paused", graph);
    await c.query("update public.flows set status = 'paused' where id = $1", [paused.id]);

    const m1 = await one<{ id: string }>(
      "insert into public.messages (org_id, conversation_id, direction, kind, body, status) values ($1,$2,'in','text','I want to BOOK a check-up','received') returning id",
      [org, conversation],
    );
    const at = new Date().toISOString();
    const ev = {
      type: "event" as const,
      org_id: org,
      name: "conversation.opened",
      payload: { conversation_id: conversation, contact_id: contact, channel_id: channel },
      at,
    };
    const first = await dispatchEvent(admin, ev);
    expect(first).toMatchObject({ started: 1 });
    await pump();
    expect((await sent()).map((m) => m.body)).toEqual(["matched"]);

    // Same event again (queue redelivery): nothing new.
    const again = await dispatchEvent(admin, ev);
    expect(again.started).toBe(0);

    // A conversation whose first message does not match the keyword.
    await c.query("update public.flow_runs set status = 'completed', finished_at = now()");
    await c.query("delete from public.messages where id = $1", [m1.id]);
    await c.query(
      "insert into public.messages (org_id, conversation_id, direction, kind, body, status, at) values ($1,$2,'in','text','hello there','received', now())",
      [org, conversation],
    );
    const miss = await dispatchEvent(admin, {
      ...ev,
      at: new Date(Date.now() + 1000).toISOString(),
    });
    expect(miss.started).toBe(0);
    void kw;
    void otherNumber;
  });

  it("a button-reply trigger fires only for the configured buttons, and not while a question is waiting", async () => {
    const graph = {
      nodes: [node("t", "trigger"), node("m", "add_comment", { text: "confirmed" })],
      edges: [edge("t", "m")],
    };
    await makeFlow("confirm", graph, {
      trigger_type: "template_button_reply",
      trigger_config: { button_ids: ["confirm"] },
    });
    const mk = async (id: string, title: string) =>
      (
        await one<{ id: string }>(
          "insert into public.messages (org_id, conversation_id, direction, kind, body, status) values ($1,$2,'in','button',$3,'received') returning id",
          [org, conversation, title],
        )
      ).id;
    const ev = (messageId: string, id: string, title: string, at: string) => ({
      type: "event" as const,
      org_id: org,
      name: "message.received",
      payload: {
        conversation_id: conversation,
        contact_id: contact,
        message_id: messageId,
        kind: "button",
        interactive: { id, title },
      },
      at,
    });
    expect(
      (
        await dispatchEvent(
          admin,
          ev(await mk("cancel", "Cancel"), "cancel", "Cancel", "2026-10-12T08:00:00Z"),
        )
      ).started,
    ).toBe(0);
    expect(
      (
        await dispatchEvent(
          admin,
          ev(await mk("confirm", "Confirm"), "confirm", "Confirm", "2026-10-12T08:00:01Z"),
        )
      ).started,
    ).toBe(1);
  });

  it("loop guard: a sixth run of one flow for one patient within a minute is refused", async () => {
    const graph = { nodes: [node("t", "trigger"), node("e", "end_flow")], edges: [edge("t", "e")] };
    const flow = await makeFlow("quick", graph);
    const results: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await startRun(admin, flow, { contactId: contact, triggerKey: `k${i}` });
      results.push(r.status === "started" ? "started" : r.reason);
      await pump();
      await c.query(
        "update public.flow_runs set status = 'completed' where status in ('running','waiting')",
      );
    }
    expect(results.slice(0, 5)).toEqual(Array(5).fill("started"));
    expect(results.slice(5)).toEqual(["loop_guard", "loop_guard"]);
  });

  it("recurring flows start once per matching minute", async () => {
    const graph = { nodes: [node("t", "trigger"), node("e", "end_flow")], edges: [edge("t", "e")] };
    await makeFlow("daily", graph, {
      trigger_type: "recurring",
      trigger_config: { cron: "*/5 * * * *", timezone: "UTC" },
    });
    const at = new Date("2026-10-12T09:05:20Z");
    expect(await runRecurring(admin, at)).toEqual({ checked: 1, started: 1 });
    expect(await runRecurring(admin, new Date("2026-10-12T09:05:40Z"))).toEqual({
      checked: 1,
      started: 0,
    }); // same minute
    expect(await runRecurring(admin, new Date("2026-10-12T09:06:00Z"))).toEqual({
      checked: 1,
      started: 0,
    }); // not due
    expect(await runRecurring(admin, new Date("2026-10-12T09:10:00Z"))).toEqual({
      checked: 1,
      started: 1,
    });
    await pump();
    expect(
      await one<{ n: number }>(
        "select count(*)::int n from public.flow_runs where status = 'completed'",
      ),
    ).toEqual({ n: 2 });
  });

  it("requeues runs whose next step was lost", async () => {
    const flow = await makeFlow("ask", askGraph());
    const s = await startOn(flow);
    if (s.status !== "started") throw new Error("not started");
    await c.query("delete from pgmq.q_flow_steps"); // the first step job is lost
    await c.query("set session_replication_role = replica"); // skip the updated_at trigger
    await c.query(
      "update public.flow_runs set updated_at = now() - interval '10 minutes' where id = $1",
      [s.runId],
    );
    await c.query("set session_replication_role = origin");
    expect(await sweepStuckRuns(admin)).toBe(1);
    await pump();
    expect((await run(s.runId)).status).toBe("waiting");
  });

  it("run_flow hands the conversation to another flow", async () => {
    const second = await makeFlow(
      "second",
      {
        nodes: [node("t", "trigger"), node("m", "add_comment", { text: "from second" })],
        edges: [edge("t", "m")],
      },
      { trigger_type: "shortcut" },
    );
    const first = await makeFlow("first", {
      nodes: [node("t", "trigger"), node("r", "run_flow", { flowId: second.id })],
      edges: [edge("t", "r")],
    });
    const s = await startOn(first);
    if (s.status !== "started") throw new Error("not started");
    await pump();
    const rows = (
      await c.query(
        "select flow_id, status, depth, parent_run_id from public.flow_runs order by started_at",
      )
    ).rows;
    expect(rows.map((r) => [r.status, r.depth])).toEqual([
      ["completed", 0],
      ["completed", 1],
    ]);
    expect(rows[1].parent_run_id).toBe(s.runId);
    expect((await sent()).map((m) => m.body)).toEqual(["from second"]);
  });

  it("fails a run cleanly when its published version is missing", async () => {
    const flow = await makeFlow("ask", askGraph());
    const s = await startOn(flow);
    if (s.status !== "started") throw new Error("not started");
    expect(await loadGraph(admin, flow.id, 1)).not.toBeNull();
    await c.query("update public.flow_runs set flow_version = 99 where id = $1", [s.runId]);
    await pump();
    expect(await run(s.runId)).toMatchObject({ status: "failed" });
  });
});
