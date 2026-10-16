/**
 * Phase 20b (flow parity) with the REAL adapters (supabase-js through PostgREST) on the plain-Postgres test database:
 * G0 (the CRM nodes reach the enquiry / task / portal / appointment services), the new nodes, the segment drip trigger and
 * the window-closing / message-received triggers. Runs only with TEST_DATABASE_URL + TEST_POSTGREST_URL + TEST_SERVICE_JWT
 * (see supabase/test/README.md); the drip trigger part needs only TEST_DATABASE_URL. Synthetic data only.
 */
import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

import { connect, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;
const withApi = Boolean(TEST_DATABASE_URL && POSTGREST_URL && SERVICE_JWT);

if (withApi) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = POSTGREST_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
  process.env.JOB_SECRET = "test-job-secret-0123456789abcdef";
}

type Node = {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
};
const n = (id: string, type: string, data: Record<string, unknown> = {}): Node => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data,
});
const e = (source: string, target: string, handle = "default") => ({
  id: `${source}-${handle}-${target}`,
  source,
  target,
  sourceHandle: handle,
});

describe.skipIf(!TEST_DATABASE_URL)("segment drip trigger (SQL)", () => {
  let c: Client;
  let org: string;
  let otherOrg: string;
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await c.query(sql, params)).rows as T[];
  const one = async (sql: string, params: unknown[] = []) =>
    (await q<{ id: string }>(sql + " returning id", params))[0]!.id;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    const u = await createAuthUser(c, "drip-owner@example.test");
    org = await createOrg(c, "Drip Org", "drip-org", u);
    otherOrg = await createOrg(c, "Other Org", "drip-other", u);
  });
  afterAll(async () => {
    await c.end();
  });

  it("queues one flow.drip job per contact added to a static segment whose drip flow is an active segment_joined flow", async () => {
    const flow = await one(
      "insert into public.flows (org_id, name, trigger_type, status) values ($1, 'Drip', 'segment_joined', 'active')",
      [org],
    );
    const draft = await one(
      "insert into public.flows (org_id, name, trigger_type, status) values ($1, 'Drip draft', 'segment_joined', 'draft')",
      [org],
    );
    const seg = await one(
      "insert into public.segments (org_id, name, kind, drip_flow_id) values ($1, 'Drip list', 'static', $2)",
      [org, flow],
    );
    const segDraft = await one(
      "insert into public.segments (org_id, name, kind, drip_flow_id) values ($1, 'Draft list', 'static', $2)",
      [org, draft],
    );
    const a = await one(
      "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Layla Demo-01', '+447700900101')",
      [org],
    );
    const b = await one(
      "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Layla Demo-02', '+447700900102')",
      [org],
    );
    await q(
      "insert into public.segment_members (org_id, segment_id, contact_id) values ($1, $2, $3), ($1, $2, $4), ($1, $5, $3)",
      [org, seg, a, b, segDraft],
    );
    const jobs = await q<{ kind: string; org_id: string; payload: Record<string, string> }>(
      "select kind, org_id, payload from public.scheduled_jobs where kind = 'flow.drip' order by payload->>'contact_id'",
    );
    expect(jobs).toHaveLength(2); // the draft flow's segment queued nothing
    expect(jobs.map((j) => j.payload.contact_id).sort()).toEqual([a, b].sort());
    expect(jobs[0]).toMatchObject({ org_id: org, payload: { segment_id: seg, flow_id: flow } });

    // Adding the same contacts again inserts no member and queues nothing.
    await q(
      "insert into public.segment_members (org_id, segment_id, contact_id) values ($1, $2, $3) on conflict do nothing",
      [org, seg, a],
    );
    expect(await q("select 1 from public.scheduled_jobs where kind = 'flow.drip'")).toHaveLength(2);
  });

  it("never queues for a dynamic segment, and refuses a drip flow from another workspace", async () => {
    const flow = await one(
      "insert into public.flows (org_id, name, trigger_type, status) values ($1, 'Drip 2', 'segment_joined', 'active')",
      [org],
    );
    const dyn = await one(
      "insert into public.segments (org_id, name, kind, filter, drip_flow_id) values ($1, 'Dyn', 'dynamic', '{}'::jsonb, $2)",
      [org, flow],
    );
    const ct = await one(
      "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Layla Demo-03', '+447700900103')",
      [org],
    );
    const before = (await q("select 1 from public.scheduled_jobs where kind = 'flow.drip'")).length;
    await q(
      "insert into public.segment_members (org_id, segment_id, contact_id) values ($1, $2, $3)",
      [org, dyn, ct],
    );
    expect(await q("select 1 from public.scheduled_jobs where kind = 'flow.drip'")).toHaveLength(
      before,
    );

    const foreign = await one(
      "insert into public.flows (org_id, name, trigger_type, status) values ($1, 'Theirs', 'segment_joined', 'active')",
      [otherOrg],
    );
    await expect(
      q(
        "insert into public.segments (org_id, name, kind, drip_flow_id) values ($1, 'Bad', 'static', $2)",
        [org, foreign],
      ),
    ).rejects.toThrow(/does not belong/);
  });

  it("accepts the four new trigger types and still rejects unknown ones", async () => {
    for (const t of ["message_received", "window_closing", "wa_flow_completed", "segment_joined"])
      await one("insert into public.flows (org_id, name, trigger_type) values ($1, $2, $2)", [
        org,
        t,
      ]);
    await expect(
      q(
        "insert into public.flows (org_id, name, trigger_type) values ($1, 'x', 'start_campaign')",
        [org],
      ),
    ).rejects.toThrow(/flows_trigger_type_check/);
  });
});

describe.skipIf(!withApi)("flow parity with the real adapters", () => {
  let c: Client;
  let admin: AdminClient;
  let org: string;
  let owner: string;
  let agent: string;
  let channel: string;
  let contact: string;
  let conv: string;
  let pipeline: string;
  let stageNew: string;
  let stageBooked: string;
  let label: string;
  const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await c.query(sql, params)).rows as T[];
  const one = async (sql: string, params: unknown[] = []) =>
    (await q<{ id: string }>(sql + " returning id", params))[0]!.id;
  const modules = async () => ({
    run: await import("@/lib/flow-engine/run"),
    deps: await import("@/lib/flow-engine/supabase-deps"),
    triggers: await import("@/lib/flow-engine/triggers"),
    adapters: await import("@/lib/flow-engine/crm-adapters"),
    starters: await import("@/lib/flow-engine/starter-flows"),
  });
  const count = (name: string) => events.filter((x) => x.name === name).length;

  async function addFlow(
    name: string,
    graph: { nodes: Node[]; edges: ReturnType<typeof e>[] },
    trigger = "shortcut",
    publishedBy: string | null = null,
    triggerConfig: Record<string, unknown> = {},
  ) {
    const id = await one(
      "insert into public.flows (org_id, name, trigger_type, trigger_config, status, version, graph, published_graph) values ($1, $2, $3, $5, 'active', 1, $4, $4)",
      [org, name, trigger, JSON.stringify(graph), JSON.stringify(triggerConfig)],
    );
    await q(
      "insert into public.flow_versions (flow_id, version, org_id, graph, published_by) values ($1, 1, $2, $3, $4)",
      [id, org, JSON.stringify(graph), publishedBy],
    );
    return id;
  }

  async function runToEnd(
    flowId: string,
    opts: { enquiryId?: string; conversationId?: string | null } = {},
  ) {
    const { run, deps } = await modules();
    const d = deps.createFlowDeps(admin);
    const s = await run.startRun(d, {
      flowId,
      contactId: contact,
      conversationId: opts.conversationId === undefined ? conv : opts.conversationId,
      enquiryId: opts.enquiryId ?? null,
    });
    if (!s.started) throw new Error(`not started: ${s.reason}`);
    for (let i = 0; i < 40; i++) {
      const [r] = await q<{ status: string; error: string | null }>(
        "select status, error from public.flow_runs where id = $1",
        [s.runId],
      );
      if (r!.status !== "running") return { id: s.runId, status: r!.status, error: r!.error };
      await run.advance(d, s.runId);
    }
    throw new Error("run did not settle");
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
      auth: { persistSession: false },
    }) as AdminClient;
    owner = await createAuthUser(c, "owner-20b@example.test");
    org = await createOrg(c, "Org 20b", "org-20b", owner);
    agent = await createAuthUser(c, "agent-20b@example.test");
    const [agentRole] = await q<{ id: string }>(
      "select id from public.roles where org_id = $1 and name = 'Agent'",
      [org],
    );
    await q("insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)", [
      org,
      agent,
      agentRole!.id,
    ]);
    channel = await one(
      "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'Main', 'waba', 'pn-20b')",
      [org],
    );
    contact = await one(
      "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Layla Demo-07', '+447700900107')",
      [org],
    );
    conv = await one(
      "insert into public.conversations (org_id, channel_id, contact_id, last_inbound_at) values ($1, $2, $3, now())",
      [org, channel, contact],
    );
    pipeline = await one(
      "insert into public.pipelines (org_id, name, is_default) values ($1, 'Recall', true)",
      [org],
    );
    stageNew = await one(
      "insert into public.stages (org_id, pipeline_id, name, sort) values ($1, $2, 'New', 0)",
      [org, pipeline],
    );
    stageBooked = await one(
      "insert into public.stages (org_id, pipeline_id, name, sort) values ($1, $2, 'Booked', 1)",
      [org, pipeline],
    );
    label = await one(
      "insert into public.tags (org_id, name, scope) values ($1, 'Follow up', 'conversation')",
      [org],
    );
    const { on } = await import("@/lib/events/emit");
    on("*", (ev) => {
      events.push({ name: ev.name, payload: ev.payload });
    });
  });

  afterAll(async () => {
    await c.end();
  });

  it("G0: the recall starter flow creates the enquiry, and a second run moves the same one (no duplicate)", async () => {
    const { starters } = await modules();
    const recall = starters.starterFlow("recall_book_now")!;
    const flow = await addFlow("Recall", recall.graph as never, recall.trigger_type);
    const first = await runToEnd(flow);
    expect(first.status).toBe("completed");
    const enquiries = await q<{
      id: string;
      title: string;
      stage_id: string;
      contact_id: string;
      created_by: string | null;
    }>(
      "select id, title, stage_id, contact_id, created_by from public.enquiries where org_id = $1",
      [org],
    );
    expect(enquiries).toEqual([
      expect.objectContaining({
        title: "Recall: wants to book",
        stage_id: stageNew,
        contact_id: contact,
        created_by: null,
      }),
    ]);
    expect(count("enquiry.created")).toBe(1);
    const steps = await q<{ node_id: string; status: string }>(
      "select node_id, status from public.flow_run_steps where run_id = $1 order by seq",
      [first.id],
    );
    expect(steps.find((s) => s.node_id === "enquiry")!.status).toBe("ok"); // not the error path
    expect(
      await q(
        "select 1 from public.audit_log where org_id = $1 and action = 'enquiry.created' and user_id is null",
        [org],
      ),
    ).toHaveLength(1);

    const second = await runToEnd(flow);
    expect(second.status).toBe("completed");
    expect(await q("select 1 from public.enquiries where org_id = $1", [org])).toHaveLength(1);
    expect(count("enquiry.created")).toBe(1);
  });

  it("update_enquiry (stage, then status with a lost reason), add_task and set_label: each event exactly once", async () => {
    const [enq] = await q<{ id: string }>("select id from public.enquiries where org_id = $1", [
      org,
    ]);
    const before = {
      stage: count("enquiry.stage_changed"),
      status: count("enquiry.status_changed"),
    };
    const flow = await addFlow("CRM steps", {
      nodes: [
        n("t", "trigger"),
        n("s", "update_enquiry", { action: "stage", stage_id: stageBooked }),
        n("s2", "update_enquiry", { action: "stage", stage_id: stageBooked }),
        n("st", "update_enquiry", {
          action: "status",
          status: "lost",
          lost_reason: "Chose another clinic",
        }),
        n("task", "add_task", {
          subject: "Call {contact.first_name}",
          type: "call",
          due_in_hours: 2,
        }),
        n("lab", "set_label", { tag_id: label, action: "add" }),
        n("end", "end_flow"),
      ],
      edges: [
        e("t", "s"),
        e("s", "s2"),
        e("s2", "st"),
        e("st", "task"),
        e("task", "lab"),
        e("lab", "end"),
      ],
    });
    const r = await runToEnd(flow, { enquiryId: enq!.id });
    expect(r).toMatchObject({ status: "completed" });
    expect(
      (
        await q("select stage_id, status, lost_reason from public.enquiries where id = $1", [
          enq!.id,
        ])
      )[0],
    ).toEqual({ stage_id: stageBooked, status: "lost", lost_reason: "Chose another clinic" });
    // Two stage steps to the same stage: the service changes it once, so the event fires once.
    expect(count("enquiry.stage_changed") - before.stage).toBe(1);
    expect(count("enquiry.status_changed") - before.status).toBe(1);
    const tasks = await q<{
      subject: string;
      enquiry_id: string;
      contact_id: string;
      created_by: string | null;
    }>("select subject, enquiry_id, contact_id, created_by from public.tasks where org_id = $1", [
      org,
    ]);
    expect(tasks).toEqual([
      { subject: "Call Layla Demo-07", enquiry_id: enq!.id, contact_id: contact, created_by: null },
    ]);
    expect(
      await q(
        "select 1 from public.conversation_labels where conversation_id = $1 and tag_id = $2",
        [conv, label],
      ),
    ).toHaveLength(1);
  });

  it("set_label refuses a label of another scope", async () => {
    const contactTag = await one(
      "insert into public.tags (org_id, name, scope) values ($1, 'VIP', 'contact')",
      [org],
    );
    const flow = await addFlow("Bad label", {
      nodes: [n("t", "trigger"), n("lab", "set_label", { tag_id: contactTag })],
      edges: [e("t", "lab")],
    });
    const r = await runToEnd(flow);
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/label does not exist/);
  });

  it("portal_record runs with the publisher's current permissions", async () => {
    const graph = {
      nodes: [
        n("t", "trigger"),
        n("p", "portal_record", {
          object: "ref_condition_groups",
          values: {
            name: "Demo group {contact.first_name}",
            key: "demo_group",
            messageable: "yes",
          },
        }),
      ],
      edges: [e("t", "p")],
    };
    const byAgent = await addFlow("Portal (agent)", graph, "shortcut", agent);
    const denied = await runToEnd(byAgent);
    expect(denied.status).toBe("failed");
    expect(denied.error).toMatch(/permission/);
    expect(
      await q("select 1 from public.ref_condition_groups where org_id = $1", [org]),
    ).toHaveLength(0);

    const byOwner = await addFlow("Portal (owner)", graph, "shortcut", owner);
    expect((await runToEnd(byOwner)).status).toBe("completed");
    expect(
      await q("select name, messageable from public.ref_condition_groups where org_id = $1", [org]),
    ).toEqual([{ name: "Demo group Layla Demo-07", messageable: true }]);

    const unpublished = await addFlow("Portal (nobody)", graph, "shortcut", null);
    expect((await runToEnd(unpublished)).error).toMatch(/nobody is recorded/);
  });

  it("book_appointment books a free slot through the booking service (source bot), and refuses a taken one", async () => {
    const { localDate, localMinutesToInstant } = await import("@/lib/appointments/slots");
    const loc = await one(
      "insert into public.locations (org_id, name) values ($1, 'Demo Clinic')",
      [org],
    );
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
      await q(
        "insert into public.working_hours (org_id, specialist_id, location_id, weekday, start_min, end_min) values ($1,$2,$3,$4,540,720)",
        [org, spec, loc, wd],
      );
    // two or more days ahead, never a Sunday (the default working week is Monday to Saturday, OQ-07)
    const isoWeekday = (d: string) => ((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
    let ahead = 2;
    while (isoWeekday(localDate(new Date(Date.now() + ahead * 86_400_000), "Asia/Dubai")) === 7)
      ahead++;
    const day = localDate(new Date(Date.now() + ahead * 86_400_000), "Asia/Dubai");
    const startsAt = localMinutesToInstant(day, 10 * 60, "Asia/Dubai").toISOString();
    const flow = await addFlow("Book", {
      nodes: [
        n("t", "trigger"),
        n("b", "book_appointment", {
          service_id: svc,
          specialist_id: spec,
          location_id: loc,
          starts_at: startsAt,
          notify: false,
        }),
      ],
      edges: [e("t", "b")],
    });
    expect((await runToEnd(flow)).status).toBe("completed");
    expect(
      await q("select source, contact_id, created_by from public.appointments where org_id = $1", [
        org,
      ]),
    ).toEqual([{ source: "bot", contact_id: contact, created_by: null }]);
    const again = await runToEnd(flow);
    expect(again.status).toBe("failed");
    expect(again.error).toMatch(/not available|taken/);
  });

  it("message_received starts once per burst; window_closing is scheduled and a later reply makes it a no-op", async () => {
    const { deps, triggers, run } = await modules();
    const d = deps.createFlowDeps(admin);
    const graph = {
      nodes: [n("t", "trigger"), n("c", "add_comment", { text: "seen" })],
      edges: [e("t", "c")],
    };
    const mr = await addFlow("On message", graph, "message_received", null, {
      debounce_seconds: 120,
    });
    const wc = await addFlow("Window", graph, "window_closing", null, { minutes_before: 30 });
    const inbound = async (wamid: string, at: Date) => {
      const id = await one(
        `insert into public.messages (org_id, conversation_id, direction, kind, body, payload, status, wa_message_id, at)
         values ($1, $2, 'in', 'text', 'what time do you open', '{}'::jsonb, 'received', $3, $4)`,
        [org, conv, wamid, at.toISOString()],
      );
      await q("update public.conversations set last_inbound_at = $2 where id = $1", [
        conv,
        at.toISOString(),
      ]);
      return id;
    };
    const t0 = new Date();
    const m1 = await inbound("wamid.20b.1", t0);
    const out = await triggers.handleTriggerEvent(d, {
      orgId: org,
      name: "message.received",
      payload: { message_id: m1, conversation_id: conv, contact_id: contact },
    });
    expect(out.started).toHaveLength(1);
    for (let i = 0; i < 5; i++) await run.advance(d, out.started[0]!);
    const m2 = await inbound("wamid.20b.2", new Date(t0.getTime() + 1000));
    const out2 = await triggers.handleTriggerEvent(d, {
      orgId: org,
      name: "message.received",
      payload: { message_id: m2, conversation_id: conv, contact_id: contact },
    });
    expect(out2.started).toHaveLength(0); // same burst
    expect(
      (await q<{ id: string }>("select id from public.flow_runs where flow_id = $1", [mr])).length,
    ).toBe(1);

    const checks = await q<{ payload: Record<string, string>; dedupe_key: string; run_at: Date }>(
      "select payload, dedupe_key, run_at from public.scheduled_jobs where kind = 'flow.window_closing' order by run_at",
    );
    expect(checks).toHaveLength(2);
    expect(checks[0]!.payload).toMatchObject({ flow_id: wc, conversation_id: conv });
    expect(checks[0]!.dedupe_key).toBe(`flow.window:${wc}:${m1}`);
    // The first check fires after the patient wrote again: nothing starts.
    expect(
      await triggers.handleWindowClosing(d, {
        orgId: org,
        flowId: wc,
        conversationId: conv,
        inboundAt: checks[0]!.payload.inbound_at!,
      }),
    ).toEqual({ started: false, reason: "newer_inbound" });
    expect(await q("select 1 from public.flow_runs where flow_id = $1", [wc])).toHaveLength(0);
  });

  it("wa_flow_completed reads the stored nfm_reply and exposes the answers as {vars.form.*}", async () => {
    const { deps, triggers, run } = await modules();
    const d = deps.createFlowDeps(admin);
    await q(
      "update public.flows set status = 'paused' where org_id = $1 and trigger_type = 'message_received'",
      [org],
    );
    const flow = await addFlow(
      "Form",
      {
        nodes: [n("t", "trigger"), n("c", "add_comment", { text: "form={vars.form.first_name}" })],
        edges: [e("t", "c")],
      },
      "wa_flow_completed",
    );
    const payload = {
      interactive: {
        type: "nfm_reply",
        nfm_reply: {
          name: "flow",
          body: "Sent",
          response_json: JSON.stringify({ flow_token: "t1", first_name: "Layla Demo-08" }),
        },
      },
    };
    const id = await one(
      `insert into public.messages (org_id, conversation_id, direction, kind, body, payload, status, wa_message_id)
       values ($1, $2, 'in', 'interactive', 'Form reply', $3, 'received', 'wamid.20b.form')`,
      [org, conv, JSON.stringify(payload)],
    );
    const out = await triggers.handleTriggerEvent(d, {
      orgId: org,
      name: "message.received",
      payload: { message_id: id, conversation_id: conv, contact_id: contact },
    });
    expect(out.started).toHaveLength(1);
    for (let i = 0; i < 5; i++) await run.advance(d, out.started[0]!);
    expect(
      await q(
        "select body from public.messages where conversation_id = $1 and direction = 'note' and body like 'form=%'",
        [conv],
      ),
    ).toEqual([{ body: "form=Layla Demo-08" }]);
    expect(
      (
        await q<{ flow_id: string }>("select flow_id from public.flow_runs where id = $1", [
          out.started[0],
        ])
      )[0]!.flow_id,
    ).toBe(flow);
  });

  it("payment_link and meta_event go through the integration code, which refuses while switched off", async () => {
    const pay = await addFlow("Pay", {
      nodes: [
        n("t", "trigger"),
        n("p", "payment_link", { invoice_number: "INV-20B-1", amount: "10.00" }),
      ],
      edges: [e("t", "p")],
    });
    const r = await runToEnd(pay);
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/switched off/);
    expect(
      await q("select 1 from public.fin_payment_requests where org_id = $1", [org]),
    ).toHaveLength(0);

    const ad = await addFlow("Ad", {
      nodes: [n("t", "trigger"), n("a", "meta_event", { event_name: "Lead" })],
      edges: [e("t", "a")],
    });
    // No ad click for this patient: a normal outcome, nothing queued.
    const noClick = await runToEnd(ad);
    expect(noClick.status).toBe("completed");
    const [step] = await q<{ output: { status: string } }>(
      "select output from public.flow_run_steps where run_id = $1 and node_id = 'a'",
      [noClick.id],
    );
    expect(step!.output.status).toBe("no_ad_click");
    // With an ad click but the integration off, the step fails (error output) and nothing is queued.
    await q(
      "insert into public.ad_attributions (org_id, contact_id, conversation_id, channel_id, ctwa_clid) values ($1, $2, $3, $4, 'clid-20b-demo')",
      [org, contact, conv, channel],
    );
    const off = await runToEnd(ad);
    expect(off.status).toBe("failed");
    expect(off.error).toMatch(/switched off/);
    expect(await q("select 1 from public.capi_events where org_id = $1", [org])).toHaveLength(0);
  });

  it("ai_router reads the stored intent label of the last inbound message; with AI off it takes Else", async () => {
    const graph = {
      nodes: [
        n("t", "trigger"),
        n("r", "ai_router", { intents: ["price", "booking"] }),
        n("price", "add_comment", { text: "route=price" }),
        n("else", "add_comment", { text: "route=else" }),
      ],
      edges: [
        e("t", "r"),
        e("r", "price", "intent:price"),
        e("r", "else", "intent:booking"),
        e("r", "else", "else"),
      ],
    };
    const flow = await addFlow("Router", graph);
    const msg = await one(
      `insert into public.messages (org_id, conversation_id, direction, kind, body, payload, status, wa_message_id, at)
       values ($1, $2, 'in', 'text', 'how much is a consultation', '{}'::jsonb, 'received', 'wamid.20b.router', now() + interval '1 hour')`,
      [org, conv],
    );
    // AI is off in this workspace and nothing is labelled: Else.
    const off = await runToEnd(flow);
    expect(off.status).toBe("completed");
    const [s1] = await q<{ output: { intent: string | null; ai: string } }>(
      "select output from public.flow_run_steps where run_id = $1 and node_id = 'r'",
      [off.id],
    );
    expect(s1!.output).toMatchObject({ intent: null, ai: "off" });
    // A label the intent pipeline already stored (no model call here) routes only with the clinical lead's signed
    // setting for that label; without it, Else.
    await q(
      "insert into public.ai_message_intents (org_id, conversation_id, message_id, source, intents, topic) values ($1, $2, $3, 'model', '{price}', 'price')",
      [org, conv, msg],
    );
    const unsigned = await runToEnd(flow);
    const [s0] = await q<{ output: { intent: string | null } }>(
      "select output from public.flow_run_steps where run_id = $1 and node_id = 'r'",
      [unsigned.id],
    );
    expect(s0!.output.intent).toBeNull();
    await q(
      `update public.orgs set settings = settings
         || jsonb_build_object('ai', coalesce(settings -> 'ai', '{}'::jsonb) || '{"enabled": true}'::jsonb)
         || jsonb_build_object('ai_copilot', jsonb_build_object('intent_detection', true, 'tag_flows',
              jsonb_build_object('enabled', true, 'tags', '["price"]'::jsonb, 'signed_by', $2::text, 'signed_at', now()::text)))
       where id = $1`,
      [org, owner],
    );
    const on = await runToEnd(flow);
    const [s2] = await q<{ output: { intent: string | null } }>(
      "select output from public.flow_run_steps where run_id = $1 and node_id = 'r'",
      [on.id],
    );
    expect(s2!.output.intent).toBe("price");
    expect(
      await q(
        "select body from public.messages where conversation_id = $1 and body like 'route=%' order by at",
        [conv],
      ),
    ).toEqual([{ body: "route=else" }, { body: "route=else" }, { body: "route=price" }]);
  });

  it("the drip job starts the segment's flow through the real store", async () => {
    const { deps, triggers } = await modules();
    const d = deps.createFlowDeps(admin);
    const flow = await addFlow(
      "Drip",
      {
        nodes: [n("t", "trigger"), n("w", "wait", { amount: 1, unit: "days" })],
        edges: [e("t", "w")],
      },
      "segment_joined",
    );
    const seg = await one(
      "insert into public.segments (org_id, name, kind, drip_flow_id) values ($1, 'Drip list', 'static', $2)",
      [org, flow],
    );
    await q(
      "insert into public.segment_members (org_id, segment_id, contact_id) values ($1, $2, $3)",
      [org, seg, contact],
    );
    const [job] = await q<{ payload: Record<string, string> }>(
      "select payload from public.scheduled_jobs where kind = 'flow.drip' and payload->>'segment_id' = $1",
      [seg],
    );
    const r = await triggers.handleSegmentJoined(d, {
      orgId: org,
      segmentId: job!.payload.segment_id!,
      contactId: job!.payload.contact_id!,
      flowId: job!.payload.flow_id!,
    });
    expect(r).toMatchObject({ started: true });
    await q("delete from public.segment_members where segment_id = $1", [seg]);
    expect(
      await triggers.handleSegmentJoined(d, {
        orgId: org,
        segmentId: seg,
        contactId: contact,
        flowId: flow,
      }),
    ).toEqual({ started: false, reason: "not_a_member" });
  });
});
