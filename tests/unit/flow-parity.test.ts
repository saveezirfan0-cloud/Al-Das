/**
 * Phase 20b (flow parity): the new nodes, the question re-ask, the new triggers and their races. In-memory ports only
 * (tests/unit/flow-fakes.ts); the real adapters are exercised in tests/db/flow-parity.test.ts. Synthetic data only.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AI_NODE_TYPES, STRIPPED_NODE_TYPES } from "@/lib/ai/flow-copilot/policy";
import { CAPI_EVENT_NAMES } from "@/lib/integrations/capi/event";
import { outputsFor } from "@/lib/flow-engine/catalog";
import type { CrmPort, RunRecord } from "@/lib/flow-engine/deps";
import { EXECUTORS } from "@/lib/flow-engine/executors";
import type { ExecCtx } from "@/lib/flow-engine/executors/common";
import { hasErrors, validateGraph } from "@/lib/flow-engine/graph";
import { NODE_DATA_SCHEMAS } from "@/lib/flow-engine/node-schemas";
import { META_EVENT_NAMES } from "@/lib/flow-engine/node-options";
import { resumeFromReply, startRun } from "@/lib/flow-engine/run";
import { simulateFlow } from "@/lib/flow-engine/simulate";
import { starterFlow } from "@/lib/flow-engine/starter-flows";
import {
  handleSegmentJoined,
  handleTriggerEvent,
  handleWindowClosing,
  windowCheckAt,
} from "@/lib/flow-engine/triggers";
import { emptyContext, type NodeType, type Outcome } from "@/lib/flow-engine/types";

import {
  CONTACT,
  CONV,
  FLOW,
  NOW,
  ORG,
  edge,
  fakeContact,
  fakeConversation,
  graph,
  harness,
  node,
  type Harness,
} from "./flow-fakes";

const UUID_A = "00000000-0000-4000-8000-00000000aa01";
const UUID_B = "00000000-0000-4000-8000-00000000aa02";
const ENQ = "00000000-0000-4000-8000-00000000e001";

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

let stepSeq = 0;

async function exec(
  h: Harness,
  type: NodeType,
  data: Record<string, unknown>,
  opts: { run?: Partial<RunRecord>; conversation?: ExecCtx["conversation"] } = {},
): Promise<Outcome> {
  return EXECUTORS[type]({
    run: runRecord(opts.run),
    node: node("n", type, data),
    deps: h.deps,
    contact: fakeContact(),
    conversation: opts.conversation === undefined ? fakeConversation() : opts.conversation,
    scope: { contact: { first_name: "Layla" }, vars: { invoice: "INV-0007", amount: "150.00" } },
    stepKey: `step-${++stepSeq}`,
  });
}

/** A CrmPort that records every call. */
function recordingCrm(over: Partial<CrmPort> = {}) {
  const calls: Array<{ method: string; input: unknown }> = [];
  const rec = (method: string, result: unknown) => async (_run: RunRecord, input?: unknown) => {
    calls.push({ method, input });
    return result as never;
  };
  const crm: CrmPort = {
    createEnquiry: rec("createEnquiry", { id: ENQ, created: true }),
    updateEnquiry: rec("updateEnquiry", { id: ENQ }),
    addTask: rec("addTask", { id: "task-1" }),
    setConversationLabel: rec("setConversationLabel", { changed: true }),
    createPaymentLink: rec("createPaymentLink", { ok: true, requestId: "req-1" }),
    sendMetaEvent: rec("sendMetaEvent", { status: "queued" }),
    ...over,
  };
  return { crm, calls };
}

// ---------------------------------------------------------------------------
// G0: the CRM nodes reach their adapter (the recall starter flow end to end)
// ---------------------------------------------------------------------------

describe("G0: the recall starter flow creates its enquiry", () => {
  it("runs create_enquiry through the port, keeps its id for later steps and does not take the error path", async () => {
    const { crm, calls } = recordingCrm();
    const h = harness({ crm });
    const starter = starterFlow("recall_book_now")!;
    h.store.addFlow(starter.graph, { trigger_type: starter.trigger_type });
    const r = await startRun(h.deps, { flowId: FLOW, contactId: CONTACT, conversationId: CONV });
    expect(r.started).toBe(true);
    await h.drain();
    const id = (r as { runId: string }).runId;
    expect(h.store.runs.get(id)!.status).toBe("completed");
    expect(calls.filter((c) => c.method === "createEnquiry")).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({ title: "Recall: wants to book", if_open: "update" });
    expect(h.store.runs.get(id)!.context.vars.enquiry_id).toBe(ENQ);
    expect(h.store.steps.find((s) => s.node_id === "enquiry")!.status).toBe("ok");
    expect(h.actions.sent).toHaveLength(1); // the reassurance message, not the fallback path only
  });

  it("production deps wire every CRM / integration / AI port method (no empty registry any more)", async () => {
    const { createFlowDeps } = await import("@/lib/flow-engine/supabase-deps");
    const deps = createFlowDeps({} as never);
    for (const m of [
      "createEnquiry",
      "updateEnquiry",
      "addTask",
      "upsertPortalRecord",
      "bookAppointment",
      "setConversationLabel",
      "createPaymentLink",
      "sendMetaEvent",
      "lastInbound",
      "intentsFor",
    ] as const)
      expect(typeof deps.crm[m], m).toBe("function");
    expect(typeof deps.jobs.scheduleTrigger).toBe("function");
  });

  it("the old import-order registry is gone", () => {
    expect(() =>
      readFileSync(path.join(process.cwd(), "lib/flow-engine/crm-registry.ts"), "utf8"),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// G3: new nodes
// ---------------------------------------------------------------------------

describe("update_enquiry", () => {
  it("acts on the enquiry created earlier in the run, else the trigger's, and calls the port exactly once", async () => {
    const { crm, calls } = recordingCrm();
    const h = harness({ crm });
    const o = await exec(
      h,
      "update_enquiry",
      {
        action: "status",
        status: "lost",
        lost_reason: "Chose {contact.first_name}'s other clinic",
      },
      { run: { enquiry_id: UUID_B, context: { ...emptyContext(), vars: { enquiry_id: ENQ } } } },
    );
    expect(o).toMatchObject({ kind: "next", output: { id: ENQ, action: "status" } });
    expect(calls).toEqual([
      {
        method: "updateEnquiry",
        input: {
          enquiry_id: ENQ,
          action: "status",
          status: "lost",
          lost_reason: "Chose Layla's other clinic",
        },
      },
    ]);
    const o2 = await exec(
      h,
      "update_enquiry",
      { action: "stage", stage_id: UUID_A },
      { run: { enquiry_id: UUID_B } },
    );
    expect(o2).toMatchObject({ kind: "next" });
    expect(calls[1]!.input).toEqual({ enquiry_id: UUID_B, action: "stage", stage_id: UUID_A });
  });

  it("fails closed without an enquiry, without the port, or with incomplete settings", async () => {
    const { crm } = recordingCrm();
    expect(
      await exec(harness({ crm }), "update_enquiry", { action: "stage", stage_id: UUID_A }),
    ).toMatchObject({
      kind: "fail",
      error: expect.stringContaining("No enquiry"),
    });
    expect(
      await exec(
        harness(),
        "update_enquiry",
        { action: "stage", stage_id: UUID_A },
        { run: { enquiry_id: ENQ } },
      ),
    ).toMatchObject({ kind: "fail", error: expect.stringContaining("not available") });
    expect(
      await exec(
        harness({ crm }),
        "update_enquiry",
        { action: "status" },
        { run: { enquiry_id: ENQ } },
      ),
    ).toMatchObject({ kind: "fail" });
  });

  it("a field change passes the interpolated value", async () => {
    const { crm, calls } = recordingCrm();
    await exec(
      harness({ crm }),
      "update_enquiry",
      { action: "field", field: "custom.insurer", value: "{vars.amount}" },
      {
        run: { enquiry_id: ENQ },
      },
    );
    expect(calls[0]!.input).toMatchObject({ field: "custom.insurer", value: "150.00" });
  });
});

describe("add_task, book_appointment, set_label", () => {
  it("add_task computes the due time from the step's clock and links the run's enquiry", async () => {
    const { crm, calls } = recordingCrm();
    const o = await exec(
      harness({ crm }),
      "add_task",
      { subject: "Call {contact.first_name}", due_in_hours: 4 },
      {
        run: { enquiry_id: ENQ },
      },
    );
    expect(o).toMatchObject({ kind: "next", output: { id: "task-1" } });
    expect(calls[0]!.input).toMatchObject({
      subject: "Call Layla",
      type: "follow_up",
      due_at: new Date(NOW.getTime() + 4 * 3_600_000).toISOString(),
      enquiry_id: ENQ,
      assignee_id: null,
    });
  });

  it("book_appointment refuses a time in the past or not a time, before calling the port", async () => {
    const { crm } = recordingCrm({
      bookAppointment: async () => ({ id: "appt-1" }),
    });
    const base = { service_id: UUID_A, specialist_id: UUID_A, location_id: UUID_A };
    expect(
      await exec(harness({ crm }), "book_appointment", {
        ...base,
        starts_at: "2020-01-01T08:00:00Z",
      }),
    ).toMatchObject({
      kind: "fail",
      error: expect.stringContaining("past"),
    });
    expect(
      await exec(harness({ crm }), "book_appointment", { ...base, starts_at: "soon" }),
    ).toMatchObject({
      kind: "fail",
    });
    expect(
      await exec(harness({ crm }), "book_appointment", {
        ...base,
        starts_at: "2026-10-20T06:00:00Z",
      }),
    ).toMatchObject({ kind: "next", vars: { appointment_id: "appt-1" } });
  });

  it("set_label adds or removes and needs a conversation", async () => {
    const { crm, calls } = recordingCrm();
    expect(
      await exec(harness({ crm }), "set_label", { tag_id: UUID_A, action: "remove" }),
    ).toMatchObject({
      kind: "next",
      output: { action: "remove", changed: true },
    });
    expect(calls[0]!.input).toEqual({ tag_id: UUID_A, on: false });
    expect(
      await exec(harness({ crm }), "set_label", { tag_id: UUID_A }, { conversation: null }),
    ).toMatchObject({ kind: "fail" });
  });
});

describe("payment_link and meta_event", () => {
  it("payment_link passes interpolated ids/values and surfaces the integration's refusal as a step failure", async () => {
    const { crm, calls } = recordingCrm();
    const ok = await exec(harness({ crm }), "payment_link", {
      invoice_number: "{vars.invoice}",
      amount: "{vars.amount}",
    });
    expect(ok).toEqual({ kind: "next", output: { request_id: "req-1" } });
    expect(calls[0]!.input).toEqual({ invoice_number: "INV-0007", amount: "150.00" });

    const off = recordingCrm({
      createPaymentLink: async () => ({
        ok: false,
        error: "This is a training workspace: payment links are never created here.",
      }),
    });
    expect(
      await exec(harness({ crm: off.crm }), "payment_link", {
        invoice_number: "INV-1",
        amount: "1",
      }),
    ).toMatchObject({
      kind: "fail",
      error: expect.stringContaining("training"),
    });
    expect(
      await exec(harness(), "payment_link", { invoice_number: "INV-1", amount: "1" }),
    ).toMatchObject({
      kind: "fail",
    });
  });

  it("meta_event: switched off / training fail; report-only, consent skips and no ad click are normal outcomes", async () => {
    for (const [status, kind] of [
      ["off", "fail"],
      ["training", "fail"],
      ["report_only", "next"],
      ["skipped:no_consent", "next"],
      ["no_ad_click", "next"],
      ["queued", "next"],
      ["duplicate", "next"],
    ] as const) {
      const { crm } = recordingCrm({ sendMetaEvent: async () => ({ status }) });
      expect(
        await exec(harness({ crm }), "meta_event", { event_name: "Lead" }),
        status,
      ).toMatchObject({ kind });
    }
    expect(await exec(harness(), "meta_event", { event_name: "Purchase" })).toMatchObject({
      kind: "fail",
    });
  });

  it("the node's event names are exactly the Conversions API's", () => {
    expect([...META_EVENT_NAMES]).toEqual([...CAPI_EVENT_NAMES]);
  });
});

describe("ai_router (draft-safe)", () => {
  const cfg = { intents: ["booking", "price"] };
  const crmWith = (body: string | null, labels: string[] | null | Error) =>
    recordingCrm({
      lastInbound: async () => (body === null ? null : { messageId: "m1", body }),
      intentsFor: async () => {
        if (labels instanceof Error) throw labels;
        return labels;
      },
    }).crm;

  it("routes to the first configured label the message carries", async () => {
    expect(
      await exec(
        harness({ crm: crmWith("how much is a check up", ["price", "booking"]) }),
        "ai_router",
        cfg,
      ),
    ).toEqual({
      kind: "next",
      handle: "intent:booking",
      output: { intent: "booking", ai: "on" },
    });
    expect(
      await exec(harness({ crm: crmWith("how much", ["price"]) }), "ai_router", cfg),
    ).toMatchObject({
      handle: "intent:price",
    });
  });

  it("takes Else when AI is off, errors, finds no label or no message", async () => {
    for (const crm of [
      crmWith("hello", null),
      crmWith("hello", new Error("provider down")),
      crmWith("hello", ["complaint"]),
      crmWith(null, ["booking"]),
      {},
    ])
      expect(await exec(harness({ crm }), "ai_router", cfg)).toMatchObject({
        kind: "next",
        handle: "else",
      });
  });

  it("emergency wording pre-empts everything, even with AI off; the model's emergency label too", async () => {
    const calls: string[] = [];
    const crm: CrmPort = {
      lastInbound: async () => ({ messageId: "m1", body: "my father has chest pain" }),
      intentsFor: async () => (calls.push("model"), ["booking"]),
    };
    expect(await exec(harness({ crm }), "ai_router", cfg)).toMatchObject({
      kind: "end",
      status: "cancelled",
      output: { emergency: true },
    });
    expect(calls).toEqual([]); // the model is not even asked
    expect(
      await exec(harness({ crm: crmWith("help", ["emergency", "booking"]) }), "ai_router", cfg),
    ).toMatchObject({
      kind: "end",
      status: "cancelled",
    });
  });

  it("never routes on emergency and its output never carries model text", async () => {
    expect(NODE_DATA_SCHEMAS.ai_router.safeParse({ intents: ["emergency"] }).success).toBe(false);
    expect(NODE_DATA_SCHEMAS.ai_router.safeParse({ intents: ["booking", "booking"] }).success).toBe(
      false,
    );
    const o = await exec(harness({ crm: crmWith("x".repeat(50), ["booking"]) }), "ai_router", cfg);
    expect(JSON.stringify(o)).not.toContain("xxxx");
  });
});

describe("every new node is decided for the copilot, and covered by the catalogue outputs", () => {
  it("the new nodes are stripped from AI drafts (a person adds them)", () => {
    for (const t of [
      "update_enquiry",
      "set_label",
      "payment_link",
      "meta_event",
      "ai_router",
    ] as const) {
      expect(STRIPPED_NODE_TYPES).toContain(t);
      expect(AI_NODE_TYPES).not.toContain(t);
    }
  });
  it("the router draws one output per label plus Else", () => {
    expect(outputsFor("ai_router", { intents: ["booking", "complaint"] }).map((o) => o.id)).toEqual(
      ["intent:booking", "intent:complaint", "else"],
    );
  });
});

// ---------------------------------------------------------------------------
// Builder checks
// ---------------------------------------------------------------------------

describe("builder checks", () => {
  const routerGraph = (edges: ReturnType<typeof edge>[], intents = ["booking", "price"]) =>
    validateGraph(
      graph(
        [
          node("t", "trigger"),
          node("r", "ai_router", { intents }),
          node("a", "end_flow"),
          node("b", "end_flow"),
        ],
        [edge("t", "r"), ...edges],
      ),
    );

  it("every router label and Else must be connected", () => {
    expect(
      hasErrors(
        routerGraph([edge("r", "a", "intent:booking"), edge("r", "b", "intent:price")]).issues,
      ),
    ).toBe(true);
    expect(
      hasErrors(
        routerGraph([
          edge("r", "a", "intent:booking"),
          edge("r", "b", "intent:price"),
          edge("r", "a", "else"),
        ]).issues,
      ),
    ).toBe(false);
  });

  it("an output for a label the router does not use, a duplicate label or emergency is an error", () => {
    expect(
      hasErrors(
        routerGraph(
          [
            edge("r", "a", "intent:booking"),
            edge("r", "b", "intent:complaint"),
            edge("r", "a", "else"),
          ],
          ["booking"],
        ).issues,
      ),
    ).toBe(true);
    expect(
      hasErrors(
        routerGraph([edge("r", "a", "else"), edge("r", "b", "intent:emergency")], ["emergency"])
          .issues,
      ),
    ).toBe(true);
  });

  it("question: every option must be connected; a missing 'No / other answer' is a warning", () => {
    const q = (edges: ReturnType<typeof edge>[]) =>
      validateGraph(
        graph(
          [
            node("t", "trigger"),
            node("q", "question", {
              text: "Book?",
              style: "buttons",
              options: [
                { id: "y", title: "Yes" },
                { id: "n", title: "No" },
              ],
            }),
            node("e", "end_flow"),
          ],
          [edge("t", "q"), ...edges],
        ),
      ).issues;
    expect(hasErrors(q([edge("q", "e", "option:y")]))).toBe(true);
    const ok = q([edge("q", "e", "option:y"), edge("q", "e", "option:n")]);
    expect(hasErrors(ok)).toBe(false);
    expect(ok.some((i) => i.level === "warning" && /No \/ other answer/.test(i.message))).toBe(
      true,
    );
  });

  it("a dangerous pattern or an e-mail field without an e-mail answer blocks publishing", () => {
    const one = (data: Record<string, unknown>) =>
      validateGraph(
        graph(
          [
            node("t", "trigger"),
            node("q", "question", { text: "Code?", style: "text", ...data }),
            node("e", "end_flow"),
          ],
          [edge("t", "q"), edge("q", "e"), edge("q", "e", "fallback")],
        ),
      ).issues;
    expect(hasErrors(one({ answer_type: "regex", pattern: "(a+)+" }))).toBe(true);
    expect(hasErrors(one({ answer_type: "regex", pattern: "^[0-9]{6}$" }))).toBe(false);
    expect(hasErrors(one({ answer_type: "text", save_to: "email" }))).toBe(true);
    expect(hasErrors(one({ answer_type: "email", save_to: "email" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G4: question validation and re-ask
// ---------------------------------------------------------------------------

describe("question: typed answers, re-ask, store", () => {
  const ask = (data: Record<string, unknown>, withFallback = true) =>
    graph(
      [
        node("t", "trigger"),
        node("q", "question", {
          text: "How many people?",
          style: "text",
          variable: "people",
          ...data,
        }),
        node("ok", "add_comment", { text: "people={vars.people}" }),
        node("fb", "add_comment", { text: "gave up" }),
      ],
      [edge("t", "q"), edge("q", "ok"), ...(withFallback ? [edge("q", "fb", "fallback")] : [])],
    );

  async function waiting(h: Harness, g: ReturnType<typeof ask>) {
    h.store.addFlow(g);
    const r = await startRun(h.deps, { flowId: FLOW, contactId: CONTACT, conversationId: CONV });
    await h.drain();
    return (r as { runId: string }).runId;
  }

  it("re-asks with the re-ask wording, then accepts a valid answer and saves it", async () => {
    const h = harness();
    const id = await waiting(
      h,
      ask({
        answer_type: "number",
        min: 1,
        max: 9,
        reask_max: 2,
        reask_text: "Please send a number from 1 to 9.",
      }),
    );
    expect(await resumeFromReply(h.deps, id, { kind: "text", text: "lots" })).toEqual({
      resumed: true,
      reason: "reask",
      invalid: true,
    });
    await h.drain();
    expect(h.actions.sent.map((s) => s.body)).toEqual([
      "How many people?",
      "Please send a number from 1 to 9.",
    ]);
    expect(h.store.runs.get(id)!.status).toBe("waiting");
    expect(await resumeFromReply(h.deps, id, { kind: "text", text: "3" })).toEqual({
      resumed: true,
    });
    await h.drain();
    expect(h.actions.comments).toEqual(["people=3"]);
    expect(h.store.runs.get(id)!.context.asks?.q).toBeUndefined();
  });

  it("after the last re-ask the fallback output runs and nothing is stored", async () => {
    const h = harness();
    const id = await waiting(h, ask({ answer_type: "number", reask_max: 1 }));
    await resumeFromReply(h.deps, id, { kind: "text", text: "a few" });
    await h.drain();
    expect(await resumeFromReply(h.deps, id, { kind: "text", text: "still a few" })).toMatchObject({
      reason: "fallback",
      invalid: true,
    });
    await h.drain();
    expect(h.actions.comments).toEqual(["gave up"]);
    expect(h.store.runs.get(id)!.context.vars.people).toBeUndefined();
    expect(h.actions.sent).toHaveLength(2); // the question and one re-ask, never more
  });

  it("re-asks count against the 200-step cap like any step (one step per re-ask)", async () => {
    const h = harness();
    const id = await waiting(h, ask({ answer_type: "number", reask_max: 3 }));
    const before = h.store.runs.get(id)!.step_count;
    await resumeFromReply(h.deps, id, { kind: "text", text: "x" });
    await h.drain();
    expect(h.store.runs.get(id)!.step_count).toBe(before + 1);
  });

  it("saves to a contact field as well as the variable", async () => {
    const h = harness();
    const id = await waiting(h, ask({ answer_type: "email", save_to: "email", variable: "mail" }));
    await resumeFromReply(h.deps, id, { kind: "text", text: "Layla.Demo07@Example.test" });
    expect(h.actions.contactUpdates).toEqual([
      { field: "email", value: "layla.demo07@example.test" },
    ]);
    expect(h.store.runs.get(id)!.context.vars.mail).toBe("layla.demo07@example.test");
  });

  it("a choice question re-asks with its buttons again", async () => {
    const h = harness();
    h.store.addFlow(
      graph(
        [
          node("t", "trigger"),
          node("q", "question", {
            text: "Book?",
            style: "buttons",
            options: [{ id: "y", title: "Yes" }],
            reask_max: 1,
            reask_text: "Please tap Yes.",
          }),
          node("c", "add_comment", { text: "yes" }),
        ],
        [edge("t", "q"), edge("q", "c", "option:y")],
      ),
    );
    const r = (await startRun(h.deps, {
      flowId: FLOW,
      contactId: CONTACT,
      conversationId: CONV,
    })) as { runId: string };
    await h.drain();
    await resumeFromReply(h.deps, r.runId, { kind: "text", text: "hmm" });
    await h.drain();
    expect(h.actions.sent[1]).toMatchObject({
      spec: { type: "interactive" },
      body: "Please tap Yes.",
    });
    // No fallback edge: after the re-ask, a second miss ends the run instead of waiting silently.
    expect(await resumeFromReply(h.deps, r.runId, { kind: "text", text: "hmm" })).toMatchObject({
      reason: "no_valid_answer",
    });
    expect(h.store.runs.get(r.runId)!.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// G2: triggers
// ---------------------------------------------------------------------------

const MSG = "00000000-0000-4000-8000-0000000000c9";
const MSG2 = "00000000-0000-4000-8000-0000000000ca";
const simple = graph(
  [node("t", "trigger"), node("c", "add_comment", { text: "hi" })],
  [edge("t", "c")],
);

function inbound(h: Harness, id: string, over: Record<string, unknown> = {}) {
  h.store.inbound.set(id, {
    id,
    conversation_id: CONV,
    contact_id: CONTACT,
    kind: "text",
    body: "what time do you open",
    reply_id: null,
    template_id: null,
    at: new Date(NOW.getTime() - 60_000).toISOString(),
    ...over,
  });
}

const received = (h: Harness, id: string, extra: Record<string, unknown> = {}) =>
  handleTriggerEvent(h.deps, {
    orgId: ORG,
    name: "message.received",
    payload: { message_id: id, conversation_id: CONV, contact_id: CONTACT, ...extra },
  });

describe("message_received", () => {
  it("starts on a message in an already-open conversation, with keyword conditions on THIS message", async () => {
    const h = harness();
    h.store.addFlow(simple, {
      trigger_type: "message_received",
      trigger_config: {
        conditions: {
          logic: "and",
          conditions: [{ category: "keyword", op: "contains", value: "open" }],
        },
      },
    });
    inbound(h, MSG);
    const out = await received(h, MSG);
    expect(out.started).toHaveLength(1);
    expect(h.store.runs.get(out.started[0]!)!.context.trigger).toMatchObject({
      facts: { keyword: "what time do you open" },
    });
    inbound(h, MSG2, { body: "thanks" });
    h.clock.now = new Date(NOW.getTime() + 3_600_000);
    await h.drain();
    expect((await received(h, MSG2)).started).toHaveLength(0); // keyword does not match
  });

  it("is debounced: a burst starts one run, a later message starts another", async () => {
    const h = harness();
    h.store.addFlow(simple, {
      trigger_type: "message_received",
      trigger_config: { debounce_seconds: 120 },
    });
    inbound(h, MSG);
    inbound(h, MSG2);
    expect((await received(h, MSG)).started).toHaveLength(1);
    await h.drain(); // the run completes
    h.clock.now = new Date(NOW.getTime() + 30_000);
    expect((await received(h, MSG2)).started).toHaveLength(0); // same burst
    h.clock.now = new Date(NOW.getTime() + 10 * 60_000);
    expect((await received(h, MSG2)).started).toHaveLength(1);
  });

  it("never starts for the message that opened the conversation, an emergency, an assigned chat or a reaction", async () => {
    const h = harness();
    h.store.addFlow(simple, { trigger_type: "message_received" });
    inbound(h, MSG);
    expect((await received(h, MSG, { opened: true })).started).toHaveLength(0);
    inbound(h, MSG, { body: "my son is not breathing" });
    expect((await received(h, MSG)).started).toHaveLength(0);
    inbound(h, MSG, { kind: "reaction", body: "👍" });
    expect((await received(h, MSG)).started).toHaveLength(0);
    inbound(h, MSG);
    h.store.conversations.get(CONV)!.assignee_user_id = UUID_A;
    expect((await received(h, MSG)).started).toHaveLength(0);
    h.store.conversations.get(CONV)!.assignee_user_id = null;
    expect((await received(h, MSG)).started).toHaveLength(1);
  });
});

describe("wa_flow_completed", () => {
  it("starts with the form's answers as run variables, filtered by flow token", async () => {
    const h = harness();
    h.store.addFlow(
      graph(
        [node("t", "trigger"), node("c", "add_comment", { text: "name={vars.form.first_name}" })],
        [edge("t", "c")],
      ),
      { trigger_type: "wa_flow_completed", trigger_config: { flow_token: "intake-v1" } },
    );
    inbound(h, MSG, {
      kind: "interactive",
      body: "Form reply",
      form: { first_name: "Layla" },
      form_token: "other",
    });
    expect((await received(h, MSG)).started).toHaveLength(0);
    inbound(h, MSG, {
      kind: "interactive",
      body: "Form reply",
      form: { first_name: "Layla" },
      form_token: "intake-v1",
    });
    const out = await received(h, MSG);
    expect(out.started).toHaveLength(1);
    await h.drain();
    expect(h.actions.comments).toEqual(["name=Layla"]);
  });
});

describe("window_closing", () => {
  const inboundAt = new Date(NOW.getTime() - 60_000).toISOString();

  it("schedules one durable check per inbound message, N minutes before the window ends", async () => {
    const h = harness();
    h.store.addFlow(simple, {
      trigger_type: "window_closing",
      trigger_config: { minutes_before: 30 },
    });
    inbound(h, MSG, { at: inboundAt });
    await received(h, MSG);
    await received(h, MSG); // a redelivered event does not schedule twice
    expect(h.jobs.triggers).toEqual([
      {
        orgId: ORG,
        kind: "flow.window_closing",
        payload: { flow_id: FLOW, conversation_id: CONV, inbound_at: inboundAt },
        runAt: new Date(Date.parse(inboundAt) + 24 * 3_600_000 - 30 * 60_000),
        dedupeKey: `flow.window:${FLOW}:${MSG}`,
      },
    ]);
    expect(
      windowCheckAt(inboundAt, 30, new Date(Date.parse(inboundAt) + 24 * 3_600_000)),
    ).toBeNull();
  });

  it("fires when nothing newer arrived and the window is still open", async () => {
    const h = harness({ now: new Date(Date.parse(inboundAt) + 23.5 * 3_600_000) });
    h.store.addFlow(simple, { trigger_type: "window_closing" });
    h.store.conversations.get(CONV)!.last_inbound_at = inboundAt;
    const r = await handleWindowClosing(h.deps, {
      orgId: ORG,
      flowId: FLOW,
      conversationId: CONV,
      inboundAt,
    });
    expect(r).toMatchObject({ started: true });
  });

  it("race: the patient replied after the check was scheduled -> the check is a no-op", async () => {
    const h = harness({ now: new Date(Date.parse(inboundAt) + 23.5 * 3_600_000) });
    h.store.addFlow(simple, {
      trigger_type: "window_closing",
      trigger_config: { minutes_before: 30 },
    });
    // 1. the first message schedules a check
    inbound(h, MSG, { at: inboundAt });
    h.clock.now = new Date(Date.parse(inboundAt));
    await received(h, MSG);
    // 2. the patient replies two hours later (processInbound moves last_inbound_at), which schedules its own check
    const replyAt = new Date(Date.parse(inboundAt) + 2 * 3_600_000).toISOString();
    h.store.conversations.get(CONV)!.last_inbound_at = replyAt;
    inbound(h, MSG2, { at: replyAt });
    h.clock.now = new Date(Date.parse(replyAt));
    await received(h, MSG2);
    expect(h.jobs.triggers.map((t) => t.payload.inbound_at)).toEqual([inboundAt, replyAt]);
    // 3. the first check fires: no-op; the second one later starts the flow
    h.clock.now = h.jobs.triggers[0]!.runAt;
    expect(
      await handleWindowClosing(h.deps, {
        orgId: ORG,
        flowId: FLOW,
        conversationId: CONV,
        inboundAt,
      }),
    ).toEqual({ started: false, reason: "newer_inbound" });
    expect(h.store.runs.size).toBe(0);
    h.clock.now = h.jobs.triggers[1]!.runAt;
    expect(
      await handleWindowClosing(h.deps, {
        orgId: ORG,
        flowId: FLOW,
        conversationId: CONV,
        inboundAt: replyAt,
      }),
    ).toMatchObject({ started: true });
  });

  it("does nothing once the window has closed, for a closed chat, or a flow that is no longer a window_closing flow", async () => {
    const h = harness({ now: new Date(Date.parse(inboundAt) + 25 * 3_600_000) });
    h.store.addFlow(simple, { trigger_type: "window_closing" });
    h.store.conversations.get(CONV)!.last_inbound_at = inboundAt;
    expect(
      await handleWindowClosing(h.deps, {
        orgId: ORG,
        flowId: FLOW,
        conversationId: CONV,
        inboundAt,
      }),
    ).toEqual({
      started: false,
      reason: "window_closed",
    });
    h.clock.now = new Date(Date.parse(inboundAt) + 23 * 3_600_000);
    h.store.conversations.get(CONV)!.status = "closed";
    expect(
      (
        await handleWindowClosing(h.deps, {
          orgId: ORG,
          flowId: FLOW,
          conversationId: CONV,
          inboundAt,
        })
      ).reason,
    ).toBe("closed");
    h.store.conversations.get(CONV)!.status = "open";
    h.store.flows.get(FLOW)!.trigger_type = "shortcut";
    expect(
      (
        await handleWindowClosing(h.deps, {
          orgId: ORG,
          flowId: FLOW,
          conversationId: CONV,
          inboundAt,
        })
      ).reason,
    ).toBe("flow_inactive");
  });
});

describe("segment drip (segment_joined)", () => {
  const SEG = "00000000-0000-4000-8000-00000000d5e1";
  const setup = (
    over: Partial<{ kind: string; drip_flow_id: string | null; member: boolean }> = {},
  ) => {
    const h = harness();
    h.store.addFlow(simple, { trigger_type: "segment_joined" });
    h.store.segments.set(SEG, {
      org_id: ORG,
      kind: over.kind ?? "static",
      drip_flow_id: over.drip_flow_id === undefined ? FLOW : over.drip_flow_id,
      members: new Set(over.member === false ? [] : [CONTACT]),
    });
    return h;
  };
  const fire = (h: Harness) =>
    handleSegmentJoined(h.deps, { orgId: ORG, segmentId: SEG, contactId: CONTACT, flowId: FLOW });

  it("starts the drip flow for the new member, without a conversation", async () => {
    const h = setup();
    const r = await fire(h);
    expect(r).toMatchObject({ started: true });
    expect(h.store.runs.get(r.runId!)).toMatchObject({
      contact_id: CONTACT,
      conversation_id: null,
    });
  });

  it("re-checks at fire time: removed again, drip changed, dynamic segment, flow not a drip flow", async () => {
    expect((await fire(setup({ member: false }))).reason).toBe("not_a_member");
    expect((await fire(setup({ drip_flow_id: null }))).reason).toBe("drip_changed");
    expect((await fire(setup({ kind: "dynamic" }))).reason).toBe("not_static");
    const h = setup();
    h.store.flows.get(FLOW)!.trigger_type = "recurring";
    expect((await fire(h)).reason).toBe("flow_inactive");
  });
});

// ---------------------------------------------------------------------------
// Dry run covers the new nodes and triggers
// ---------------------------------------------------------------------------

describe("dry run", () => {
  it("simulates the new nodes without doing anything and the router takes Else (AI is never called)", async () => {
    const r = await simulateFlow({
      graph: graph(
        [
          node("trigger", "trigger"),
          node("enq", "create_enquiry", { title: "From {contact.first_name}" }),
          node("upd", "update_enquiry", { action: "stage", stage_id: UUID_A }),
          node("lab", "set_label", { tag_id: UUID_A }),
          node("pay", "payment_link", { invoice_number: "INV-1", amount: "10" }),
          node("ad", "meta_event", { event_name: "Lead" }),
          node("router", "ai_router", { intents: ["booking"] }),
          node("book", "add_comment", { text: "booking" }),
          node("other", "end_flow"),
        ],
        [
          edge("trigger", "enq"),
          edge("enq", "upd"),
          edge("upd", "lab"),
          edge("lab", "pay"),
          edge("pay", "ad"),
          edge("ad", "router"),
          edge("router", "book", "intent:booking"),
          edge("router", "other", "else"),
        ],
      ),
      triggerType: "message_received",
      inbound: ["I would like to book"],
    });
    expect(r.status).toBe("completed");
    expect(r.steps.map((s) => s.nodeId)).toEqual([
      "trigger",
      "enq",
      "upd",
      "lab",
      "pay",
      "ad",
      "router",
      "other",
    ]);
    expect(r.steps.find((s) => s.nodeId === "pay")!.detail).toMatch(
      /payment link.*not done in a dry run/,
    );
    expect(r.steps.find((s) => s.nodeId === "router")!.detail).toMatch(/Else/);
  });

  it("the router stops on emergency wording in a dry run too", async () => {
    const r = await simulateFlow({
      graph: graph(
        [
          node("trigger", "trigger"),
          node("router", "ai_router", { intents: ["booking"] }),
          node("e", "end_flow"),
        ],
        [
          edge("trigger", "router"),
          edge("router", "e", "intent:booking"),
          edge("router", "e", "else"),
        ],
      ),
      triggerType: "message_received",
      inbound: ["chest pain since this morning"],
    });
    expect(r.status).toBe("stopped");
    expect(r.steps.find((s) => s.nodeId === "router")!.detail).toMatch(/emergency/);
  });

  it("counts answers that did not fit and shows the re-ask", async () => {
    const r = await simulateFlow({
      graph: graph(
        [
          node("trigger", "trigger"),
          node("q", "question", {
            text: "Your age?",
            style: "text",
            answer_type: "number",
            reask_max: 1,
          }),
          node("e", "end_flow"),
        ],
        [edge("trigger", "q"), edge("q", "e"), edge("q", "e", "fallback")],
      ),
      triggerType: "shortcut",
      inbound: ["old", "42"],
    });
    expect(r.status).toBe("completed");
    expect(r.unmatchedReplies).toBe(1);
    expect(r.sent).toHaveLength(2);
  });

  it("window_closing and segment_joined dry runs need no sample message", async () => {
    for (const triggerType of ["window_closing", "wa_flow_completed"]) {
      const r = await simulateFlow({ graph: simple, triggerType, inbound: [] });
      expect(r.status, triggerType).toBe("completed");
    }
    // A drip run has no conversation (like Recurring): a note needs one, a template would not.
    const drip = await simulateFlow({ graph: simple, triggerType: "segment_joined", inbound: [] });
    expect(drip.status).toBe("failed");
    expect(drip.reason).toMatch(/needs a conversation/);
  });
});
