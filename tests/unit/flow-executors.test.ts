import { describe, expect, it } from "vitest";

import type { RunRecord } from "@/lib/flow-engine/deps";
import { EXECUTORS } from "@/lib/flow-engine/executors";
import type { ExecCtx } from "@/lib/flow-engine/executors/common";
import { NODE_TYPES, emptyContext, type NodeType, type Outcome } from "@/lib/flow-engine/types";

import {
  CONTACT,
  CONV,
  FLOW,
  ORG,
  NOW,
  edge,
  fakeContact,
  fakeConversation,
  graph,
  harness,
  node,
  type Harness,
} from "./flow-fakes";

const TPL = "00000000-0000-4000-8000-0000000000a1";

function runRecord(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "00000000-0000-4000-8000-0000000000b1",
    org_id: ORG,
    flow_id: FLOW,
    flow_version: 1,
    contact_id: CONTACT,
    conversation_id: CONV,
    enquiry_id: null,
    status: "running",
    current_node_id: "n",
    context: emptyContext(),
    waiting_for: null,
    step_count: 0,
    parent_run_id: null,
    error: null,
    ...over,
  };
}

async function exec(
  h: Harness,
  type: NodeType,
  data: Record<string, unknown>,
  opts: {
    contact?: ExecCtx["contact"];
    conversation?: ExecCtx["conversation"];
    run?: Partial<RunRecord>;
    scope?: Record<string, unknown>;
  } = {},
): Promise<Outcome> {
  const ctx: ExecCtx = {
    run: runRecord(opts.run),
    node: node("n", type, data),
    deps: h.deps,
    contact: opts.contact === undefined ? fakeContact() : opts.contact,
    conversation: opts.conversation === undefined ? fakeConversation() : opts.conversation,
    scope: opts.scope ?? { contact: { first_name: "Sara" }, vars: { CLINIC: "Al Das" } },
  };
  return EXECUTORS[type](ctx);
}

describe("every node type has an executor", () => {
  it("registry covers NODE_TYPES", () => {
    for (const t of NODE_TYPES) expect(typeof EXECUTORS[t]).toBe("function");
  });
});

describe("trigger / end_flow", () => {
  it("trigger continues, end_flow completes", async () => {
    const h = harness();
    expect(await exec(h, "trigger", {})).toEqual({ kind: "next" });
    expect(await exec(h, "end_flow", {})).toEqual({ kind: "end", status: "completed" });
  });
});

describe("message", () => {
  it("sends interpolated text", async () => {
    const h = harness();
    const o = await exec(h, "message", { text: "Hello {contact.first_name} from {vars.CLINIC}" });
    expect(o.kind).toBe("next");
    expect(h.actions.sent[0]!.spec).toEqual({ type: "text", body: "Hello Sara from Al Das" });
  });
  it("fails (no send) when the 24h window is closed", async () => {
    const h = harness();
    const conversation = fakeConversation({
      last_inbound_at: new Date(NOW.getTime() - 25 * 3_600_000).toISOString(),
    });
    const o = await exec(h, "message", { text: "hi" }, { conversation });
    expect(o).toMatchObject({ kind: "fail" });
    expect(h.actions.sent).toHaveLength(0);
  });
  it("allows the 72h window for click-to-WhatsApp conversations", async () => {
    const h = harness();
    const conversation = fakeConversation({
      last_inbound_at: null,
      ad_referral: { source_id: "1" },
      opened_at: new Date(NOW.getTime() - 40 * 3_600_000).toISOString(),
    });
    expect((await exec(h, "message", { text: "hi" }, { conversation })).kind).toBe("next");
  });
  it("fails on empty text, missing conversation and invalid config", async () => {
    const h = harness();
    expect((await exec(h, "message", { text: "{contact.nickname}" })).kind).toBe("fail");
    expect((await exec(h, "message", { text: "hi" }, { conversation: null })).kind).toBe("fail");
    expect((await exec(h, "message", {})).kind).toBe("fail");
    expect(h.actions.sent).toHaveLength(0);
  });
});

describe("question", () => {
  it("sends reply buttons and waits with the options", async () => {
    const h = harness();
    const o = await exec(h, "question", {
      text: "Book a visit?",
      style: "buttons",
      options: [
        { id: "y", title: "Yes" },
        { id: "n", title: "No" },
      ],
      variable: "wants_visit",
    });
    expect(o.kind).toBe("wait");
    const spec = h.actions.sent[0]!.spec;
    expect(spec.type).toBe("interactive");
    if (o.kind === "wait" && o.waiting.kind === "reply") {
      expect(o.waiting.options.map((x) => x.id)).toEqual(["y", "n"]);
      expect(o.waiting.variable).toBe("wants_visit");
    }
    expect(h.jobs.resumes).toHaveLength(0);
  });
  it("sends a list and schedules a timeout resume", async () => {
    const h = harness();
    const options = Array.from({ length: 10 }, (_, i) => ({ id: `o${i}`, title: `Option ${i}` }));
    const o = await exec(h, "question", {
      text: "Pick",
      style: "list",
      options,
      timeout_seconds: 600,
    });
    expect(o.kind).toBe("wait");
    expect(h.jobs.resumes).toHaveLength(1);
    expect(h.jobs.resumes[0]!.runAt.getTime()).toBe(NOW.getTime() + 600_000);
    if (o.kind === "wait" && o.waiting.kind === "reply")
      expect(h.jobs.resumes[0]!.token).toBe(o.waiting.token);
  });
  it("free-text question sends plain text", async () => {
    const h = harness();
    await exec(h, "question", { text: "Your name?", style: "text" });
    expect(h.actions.sent[0]!.spec.type).toBe("text");
  });
  it("rejects >3 buttons, >10 rows, duplicate ids and a closed window", async () => {
    const h = harness();
    const four = ["a", "b", "c", "d"].map((id) => ({ id, title: id }));
    expect((await exec(h, "question", { text: "x", style: "buttons", options: four })).kind).toBe(
      "fail",
    );
    const eleven = Array.from({ length: 11 }, (_, i) => ({ id: `o${i}`, title: `T${i}` }));
    expect((await exec(h, "question", { text: "x", style: "list", options: eleven })).kind).toBe(
      "fail",
    );
    expect(
      (
        await exec(h, "question", {
          text: "x",
          style: "buttons",
          options: [
            { id: "a", title: "A" },
            { id: "a", title: "B" },
          ],
        })
      ).kind,
    ).toBe("fail");
    const closed = fakeConversation({ last_inbound_at: null });
    expect((await exec(h, "question", { text: "x" }, { conversation: closed })).kind).toBe("fail");
    expect(h.actions.sent).toHaveLength(0);
  });
});

describe("quick_reply", () => {
  it("sends up to 3 buttons and continues without waiting", async () => {
    const h = harness();
    const o = await exec(h, "quick_reply", {
      text: "Choose",
      buttons: [
        { id: "a", title: "A" },
        { id: "b", title: "B" },
      ],
    });
    expect(o.kind).toBe("next");
    expect(h.actions.sent[0]!.spec.type).toBe("interactive");
  });
  it("rejects zero or four buttons", async () => {
    const h = harness();
    expect((await exec(h, "quick_reply", { text: "x", buttons: [] })).kind).toBe("fail");
    expect(
      (
        await exec(h, "quick_reply", {
          text: "x",
          buttons: ["a", "b", "c", "d"].map((id) => ({ id, title: id })),
        })
      ).kind,
    ).toBe("fail");
  });
});

describe("template", () => {
  function withTemplate(h: Harness, over: Partial<{ status: string; category: string }> = {}) {
    h.store.templates.set(TPL, {
      id: TPL,
      name: "appointment_reminder",
      status: over.status ?? "APPROVED",
      category: over.category ?? "UTILITY",
      components: [],
      variable_map: { "body.1": "contact.first_name" },
    });
  }
  it("sends an approved template with variable_map values", async () => {
    const h = harness();
    withTemplate(h);
    const o = await exec(h, "template", { template_id: TPL });
    expect(o.kind).toBe("next");
    expect(h.actions.sent[0]!.spec).toEqual({
      type: "template",
      template_id: TPL,
      values: { "body.1": "Sara" },
    });
  });
  it("node values override the template map and can use free text", async () => {
    const h = harness();
    withTemplate(h);
    await exec(h, "template", {
      template_id: TPL,
      values: { "body.1": "Dear {contact.first_name}" },
    });
    expect((h.actions.sent[0]!.spec as { values: Record<string, string> }).values["body.1"]).toBe(
      "Dear Sara",
    );
  });
  it("works outside the 24h window (templates are exempt) and without a conversation", async () => {
    const h = harness();
    withTemplate(h);
    const closed = fakeConversation({ last_inbound_at: null });
    expect((await exec(h, "template", { template_id: TPL }, { conversation: closed })).kind).toBe(
      "next",
    );
    expect((await exec(h, "template", { template_id: TPL }, { conversation: null })).kind).toBe(
      "next",
    );
  });
  it("fails for unapproved or missing templates", async () => {
    const h = harness();
    expect((await exec(h, "template", { template_id: TPL })).kind).toBe("fail");
    withTemplate(h, { status: "PENDING" });
    expect((await exec(h, "template", { template_id: TPL })).kind).toBe("fail");
    expect(h.actions.sent).toHaveLength(0);
  });
  it("blocks marketing templates for stop_marketing and non-opted-in patients, not utility ones", async () => {
    const h = harness();
    withTemplate(h, { category: "MARKETING" });
    expect(
      (
        await exec(
          h,
          "template",
          { template_id: TPL },
          { contact: fakeContact({ stop_marketing: true }) },
        )
      ).kind,
    ).toBe("fail");
    expect(
      (
        await exec(
          h,
          "template",
          { template_id: TPL },
          { contact: fakeContact({ promotions_opt_in: false }) },
        )
      ).kind,
    ).toBe("fail");
    expect(h.actions.sent).toHaveLength(0);
    withTemplate(h, { category: "UTILITY" });
    expect(
      (
        await exec(
          h,
          "template",
          { template_id: TPL },
          { contact: fakeContact({ promotions_opt_in: false }) },
        )
      ).kind,
    ).toBe("next");
  });
});

describe("branch", () => {
  it("follows true / false", async () => {
    const h = harness();
    const cfg = { logic: "and", conditions: [{ left: "vars.age", op: "gte", right: "18" }] };
    expect(await exec(h, "branch", cfg, { scope: { vars: { age: "30" } } })).toMatchObject({
      kind: "next",
      handle: "true",
    });
    expect(await exec(h, "branch", cfg, { scope: { vars: { age: "10" } } })).toMatchObject({
      kind: "next",
      handle: "false",
    });
    expect(await exec(h, "branch", cfg, { scope: { vars: {} } })).toMatchObject({
      handle: "false",
    });
  });
  it("fails on invalid config", async () => {
    expect((await exec(harness(), "branch", { conditions: [{ left: "", op: "eq" }] })).kind).toBe(
      "fail",
    );
  });
});

describe("wait", () => {
  it("schedules a resume job and waits", async () => {
    const h = harness();
    const o = await exec(h, "wait", { amount: 2, unit: "hours" });
    expect(o.kind).toBe("wait");
    expect(h.jobs.resumes[0]!.runAt.getTime()).toBe(NOW.getTime() + 2 * 3_600_000);
    if (o.kind === "wait") expect(o.waiting.kind).toBe("timer");
  });
  it("rejects zero, negative and >30 day waits", async () => {
    const h = harness();
    expect((await exec(h, "wait", { amount: 0, unit: "hours" })).kind).toBe("fail");
    expect((await exec(h, "wait", { amount: 31, unit: "days" })).kind).toBe("fail");
    expect(h.jobs.resumes).toHaveLength(0);
  });
});

describe("office_hours", () => {
  const schedule = { mon: [{ start: "09:00", end: "18:00" }] };
  it("routes inside / outside", async () => {
    // Monday 2026-10-12 06:00Z = 10:00 Dubai
    const inside = harness({ now: new Date("2026-10-12T06:00:00Z") });
    expect(await exec(inside, "office_hours", { timezone: "Asia/Dubai", schedule })).toMatchObject({
      handle: "inside",
    });
    const outside = harness({ now: new Date("2026-10-12T16:00:00Z") });
    expect(await exec(outside, "office_hours", { timezone: "Asia/Dubai", schedule })).toMatchObject(
      { handle: "outside" },
    );
  });
  it("fails on malformed times", async () => {
    expect(
      (await exec(harness(), "office_hours", { schedule: { mon: [{ start: "9am", end: "6pm" }] } }))
        .kind,
    ).toBe("fail");
  });
});

describe("run_flow", () => {
  const CHILD = "00000000-0000-4000-8000-0000000000f2";
  function setup(h: Harness, over: { status?: "active" | "draft" } = {}) {
    const g = graph([node("t", "trigger"), node("e", "end_flow")], [edge("t", "e")]);
    h.store.flows.set(CHILD, {
      id: CHILD,
      org_id: ORG,
      name: "child",
      status: over.status ?? "active",
      trigger_type: "shortcut",
      trigger_config: {},
      channel_id: null,
      version: 1,
      published_graph: g,
    });
    h.store.graphs.set(`${CHILD}:1`, g);
  }
  it("starts a child run and waits for it", async () => {
    const h = harness();
    setup(h);
    const o = await exec(h, "run_flow", { flow_id: CHILD });
    expect(o.kind).toBe("wait");
    expect(h.jobs.steps).toHaveLength(1);
    const child = [...h.store.runs.values()][0]!;
    expect(child.parent_run_id).toBe(runRecord().id);
    expect(child.context.depth).toBe(1);
  });
  it("blocks self-calls, drafts, foreign orgs and deep nesting", async () => {
    const h = harness();
    setup(h, { status: "draft" });
    expect((await exec(h, "run_flow", { flow_id: CHILD })).kind).toBe("fail");
    expect((await exec(h, "run_flow", { flow_id: FLOW })).kind).toBe("fail");
    setup(h);
    expect(
      (
        await exec(
          h,
          "run_flow",
          { flow_id: CHILD },
          { run: { context: { ...emptyContext(), depth: 3 } } },
        )
      ).kind,
    ).toBe("fail");
    h.store.flows.get(CHILD)!.org_id = "00000000-0000-4000-8000-0000000000ff";
    expect((await exec(h, "run_flow", { flow_id: CHILD })).kind).toBe("fail");
  });
});

describe("assign_to", () => {
  const USER = "00000000-0000-4000-8000-0000000000a2";
  it("assigning to a person or team hands over and ends the flow", async () => {
    const h = harness();
    expect(await exec(h, "assign_to", { target: { type: "user", id: USER } })).toMatchObject({
      kind: "end",
      status: "completed",
    });
    expect(await exec(h, "assign_to", { target: { type: "team", id: USER } })).toMatchObject({
      kind: "end",
    });
    expect(h.actions.assigned).toEqual([
      { type: "user", id: USER },
      { type: "team", id: USER },
    ]);
  });
  it("bot / unassign continue", async () => {
    const h = harness();
    expect((await exec(h, "assign_to", { target: { type: "bot" } })).kind).toBe("next");
    expect((await exec(h, "assign_to", { target: { type: "unassign" } })).kind).toBe("next");
  });
  it("fails without a conversation or a valid target", async () => {
    const h = harness();
    expect(
      (await exec(h, "assign_to", { target: { type: "bot" } }, { conversation: null })).kind,
    ).toBe("fail");
    expect((await exec(h, "assign_to", { target: { type: "user", id: "nope" } })).kind).toBe(
      "fail",
    );
  });
});

describe("close_conversation", () => {
  it("closes and ends the run", async () => {
    const h = harness();
    expect(await exec(h, "close_conversation", {})).toMatchObject({
      kind: "end",
      status: "completed",
    });
    expect(h.actions.closed).toBe(1);
  });
  it("fails without a conversation", async () => {
    const h = harness();
    expect((await exec(h, "close_conversation", {}, { conversation: null })).kind).toBe("fail");
    expect(h.actions.closed).toBe(0);
  });
});

describe("add_comment", () => {
  it("adds an interpolated internal note", async () => {
    const h = harness();
    expect((await exec(h, "add_comment", { text: "Bot note for {contact.first_name}" })).kind).toBe(
      "next",
    );
    expect(h.actions.comments).toEqual(["Bot note for Sara"]);
  });
  it("fails on empty text or no conversation", async () => {
    const h = harness();
    expect((await exec(h, "add_comment", { text: "{vars.NOPE}" })).kind).toBe("fail");
    expect((await exec(h, "add_comment", { text: "x" }, { conversation: null })).kind).toBe("fail");
  });
});

describe("update_contact_field", () => {
  it("updates allowed fields with interpolation", async () => {
    const h = harness();
    expect(
      (await exec(h, "update_contact_field", { field: "label", value: "VIP {contact.first_name}" }))
        .kind,
    ).toBe("next");
    expect(
      (await exec(h, "update_contact_field", { field: "custom.interest", value: "dental" })).kind,
    ).toBe("next");
    expect(h.actions.contactUpdates).toEqual([
      { field: "label", value: "VIP Sara" },
      { field: "custom.interest", value: "dental" },
    ]);
  });
  it("refuses phone, unknown fields, bad gender and bad email", async () => {
    const h = harness();
    for (const d of [
      { field: "phone_e164", value: "+971500000000" },
      { field: "stop_marketing", value: "true" },
      { field: "gender", value: "x" },
      { field: "email", value: "not-an-email" },
    ]) {
      expect((await exec(h, "update_contact_field", d)).kind, d.field).toBe("fail");
    }
    expect(h.actions.contactUpdates).toHaveLength(0);
  });
  it("needs a contact", async () => {
    expect(
      (
        await exec(
          harness(),
          "update_contact_field",
          { field: "label", value: "x" },
          { contact: null },
        )
      ).kind,
    ).toBe("fail");
  });
});

describe("CRM port nodes", () => {
  for (const [type, method] of [
    ["create_enquiry", "createEnquiry"],
    ["add_task", "addTask"],
    ["portal_record", "upsertPortalRecord"],
    ["book_appointment", "bookAppointment"],
  ] as const) {
    it(`${type} fails closed with no adapter and calls the adapter when present`, async () => {
      const none = harness();
      const o = await exec(none, type, { title: "x" });
      expect(o).toMatchObject({ kind: "fail" });
      expect((o as { error: string }).error).toContain("not available yet");

      const calls: Array<Record<string, unknown>> = [];
      const h = harness({
        crm: {
          [method]: async (_r: RunRecord, input: Record<string, unknown>) => (
            calls.push(input),
            { id: "rec-1" }
          ),
        },
      });
      const ok = await exec(h, type, { title: "Call {contact.first_name}" });
      expect(ok).toMatchObject({ kind: "next", output: { id: "rec-1" } });
      expect(calls[0]).toEqual({ title: "Call Sara" });
    });
  }
});

describe("api_action", () => {
  it("calls the URL with interpolated parts and exposes the response", async () => {
    const h = harness();
    h.actions.httpResponse = { status: 200, body: { slot: "10:00" } };
    const o = await exec(h, "api_action", {
      method: "POST",
      url: "https://api.example.com/slots?name={contact.first_name}",
      headers: { "X-Clinic": "{vars.CLINIC}" },
      body: '{"name":"{contact.first_name}"}',
    });
    expect(o).toMatchObject({ kind: "next", output: { status: 200, slot: "10:00" } });
    expect(h.actions.httpCalls[0]).toMatchObject({
      method: "POST",
      url: "https://api.example.com/slots?name=Sara",
      headers: { "X-Clinic": "Al Das" },
    });
  });
  it("fails on non-2xx and keeps the response for the fallback path", async () => {
    const h = harness();
    h.actions.httpResponse = { status: 500, body: { error: "boom" } };
    expect(await exec(h, "api_action", { url: "https://api.example.com/x" })).toMatchObject({
      kind: "fail",
      error: "HTTP 500",
    });
  });
  it("never calls unsafe URLs", async () => {
    const h = harness();
    for (const url of [
      "http://api.example.com",
      "https://169.254.169.254/",
      "https://localhost/x",
      "https://{vars.NOPE}",
    ]) {
      expect((await exec(h, "api_action", { url })).kind, url).toBe("fail");
    }
    expect(h.actions.httpCalls).toHaveLength(0);
  });
});

describe("send_notification", () => {
  it("notifies the target with interpolated text", async () => {
    const h = harness();
    const user = "00000000-0000-4000-8000-0000000000a3";
    const o = await exec(h, "send_notification", {
      target: { type: "user", id: user },
      title: "Call {contact.first_name}",
      body: "Please call back",
    });
    expect(o).toMatchObject({ kind: "next", output: { notified: 1 } });
    expect(h.actions.notifications[0]).toMatchObject({
      title: "Call Sara",
      body: "Please call back",
    });
  });
  it("fails on missing title", async () => {
    expect(
      (
        await exec(harness(), "send_notification", {
          target: { type: "role", id: "Manager" },
          title: "",
        })
      ).kind,
    ).toBe("fail");
  });
});
