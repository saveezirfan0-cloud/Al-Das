/**
 * Replay-safe flow sends (docs/23_PHASE_20B_NOTES.md, "Replay-safe sends").
 *
 * The window: advance() writes the step row ('running'), the node queues its message, and only then is the outcome stored
 * on the step. A crash in between leaves the step 'running', so the redelivered job runs the node again. Every send now
 * carries the step key (run id + seq) and messages.flow_step_key is unique, so the second attempt gets the first message
 * back. These tests cover the engine (same key on replay, distinct keys per step and per re-ask), every message-sending
 * executor, and queueOutbound's handling of the unique key. Synthetic data only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.fn<(...args: unknown[]) => Promise<number>>(async () => 1);
vi.mock("@/lib/jobs/enqueue", () => ({
  enqueue: (...a: unknown[]) => enqueue(...a),
  scheduleJob: vi.fn(async () => ({ id: null, deduped: false })),
}));

import { EXECUTORS } from "@/lib/flow-engine/executors";
import type { ExecCtx } from "@/lib/flow-engine/executors/common";
import type { CrmPort, RunRecord } from "@/lib/flow-engine/deps";
import { advance, resumeFromReply, startRun } from "@/lib/flow-engine/run";
import { emptyContext, flowStepKey, type NodeType } from "@/lib/flow-engine/types";
import { queueOutbound, RetryExistsError } from "@/lib/inbox/send";
import type { AdminClient } from "@/lib/supabase/admin";

import {
  CONTACT,
  CONV,
  FLOW,
  ORG,
  edge,
  fakeContact,
  fakeConversation,
  graph,
  harness,
  node,
  type Harness,
} from "./flow-fakes";

const TPL = "00000000-0000-4000-8000-0000000000b1";

async function start(h: Harness) {
  const r = await startRun(h.deps, { flowId: FLOW, contactId: CONTACT, conversationId: CONV });
  if (!r.started) throw new Error(`not started: ${r.reason}`);
  h.jobs.steps.length = 0;
  return r.runId;
}

/** The next updateStep call fails once: the message is queued but the step outcome is never stored. */
function crashBeforeStepRecorded(h: Harness) {
  const real = h.store.updateStep.bind(h.store);
  let armed = true;
  h.store.updateStep = async (...args) => {
    if (armed) {
      armed = false;
      throw new Error("connection lost");
    }
    return real(...args);
  };
}

describe("flow step key", () => {
  it("is the run id and the step seq", () => {
    expect(flowStepKey("00000000-0000-4000-8000-000000000123", 7)).toBe(
      "00000000-0000-4000-8000-000000000123:7",
    );
  });
});

describe("advance: crash between 'queued' and 'step recorded'", () => {
  const sendingNodes: Array<[string, NodeType, Record<string, unknown>]> = [
    ["message", "message", { text: "Hello {contact.first_name}" }],
    ["quick_reply", "quick_reply", { text: "Pick", buttons: [{ id: "a", title: "A" }] }],
    [
      "question (buttons)",
      "question",
      { text: "Book?", style: "buttons", options: [{ id: "y", title: "Yes" }] },
    ],
    ["question (text)", "question", { text: "Your name?" }],
    ["template", "template", { template_id: TPL }],
  ];

  it.each(sendingNodes)(
    "%s: the replay queues nothing new and records the same message id",
    async (_label, type, data) => {
      const h = harness();
      h.store.templates.set(TPL, {
        id: TPL,
        name: "visit_reminder",
        status: "APPROVED",
        category: "UTILITY",
        components: [],
        variable_map: {},
      });
      h.store.addFlow(
        graph(
          [node("t", "trigger"), node("s", type, data), node("e", "end_flow")],
          [edge("t", "s"), edge("s", "e")],
        ),
      );
      const id = await start(h);
      await advance(h.deps, id); // trigger (seq 1)

      crashBeforeStepRecorded(h);
      await expect(advance(h.deps, id)).rejects.toThrow("connection lost");
      expect(h.actions.sent).toHaveLength(1);
      const step = h.store.steps.find((s) => s.node_id === "s")!;
      expect(step.status).toBe("running"); // the outcome was never stored: the job will be redelivered
      expect(h.store.runs.get(id)!.current_node_id).toBe("s");

      // Redelivery: the node runs again with the SAME key, so nothing new is queued.
      await advance(h.deps, id);
      expect(h.actions.sendCalls).toEqual([flowStepKey(id, 2), flowStepKey(id, 2)]);
      expect(h.actions.sent).toHaveLength(1);
      expect(h.actions.sent[0]!.stepKey).toBe(flowStepKey(id, 2));
      const after = h.store.steps.find((s) => s.node_id === "s")!;
      expect(after.output?.message_id).toBe("m1");
      expect(h.store.steps.filter((s) => s.node_id === "s")).toHaveLength(1);
    },
  );

  it("two message steps in a row get two keys and two messages", async () => {
    const h = harness();
    h.store.addFlow(
      graph(
        [
          node("t", "trigger"),
          node("m1", "message", { text: "One" }),
          node("m2", "message", { text: "Two" }),
        ],
        [edge("t", "m1"), edge("m1", "m2")],
      ),
    );
    const id = await start(h);
    await h.deps.jobs.enqueueStep(id);
    await h.drain();
    expect(h.actions.sent.map((s) => s.stepKey)).toEqual([flowStepKey(id, 2), flowStepKey(id, 3)]);
    expect(h.store.runs.get(id)!.status).toBe("completed");
  });

  it("a re-ask is a new step with its own key, so it is sent (once)", async () => {
    const h = harness();
    h.store.addFlow(
      graph(
        [
          node("t", "trigger"),
          node("q", "question", {
            text: "Your age?",
            answer_type: "number",
            reask_max: 1,
            reask_text: "Please type a number",
          }),
          node("e", "end_flow"),
        ],
        [edge("t", "q"), edge("q", "e")],
      ),
    );
    const id = await start(h);
    await h.deps.jobs.enqueueStep(id);
    await h.drain();
    expect(h.actions.sent).toHaveLength(1);

    expect(await resumeFromReply(h.deps, id, { kind: "text", text: "abc" })).toMatchObject({
      reason: "reask",
    });
    crashBeforeStepRecorded(h);
    await expect(advance(h.deps, id)).rejects.toThrow("connection lost");
    await advance(h.deps, id); // redelivered re-ask
    expect(h.actions.sent.map((s) => [s.stepKey, s.body])).toEqual([
      [flowStepKey(id, 2), "Your age?"],
      [flowStepKey(id, 3), "Please type a number"],
    ]);
    expect(h.store.runs.get(id)!.status).toBe("waiting");
  });
});

describe("ports that send or book get the step key", () => {
  const stepRun = (): RunRecord => ({
    id: "00000000-0000-4000-8000-0000000000a1",
    org_id: ORG,
    flow_id: FLOW,
    flow_version: 1,
    contact_id: CONTACT,
    conversation_id: CONV,
    enquiry_id: null,
    status: "running",
    current_node_id: "p",
    context: emptyContext(),
    waiting_for: null,
    step_count: 4,
    parent_run_id: null,
    error: null,
  });
  const ctxFor = (h: Harness, type: NodeType, data: Record<string, unknown>): ExecCtx => {
    const run = stepRun();
    return {
      run,
      node: node("p", type, data),
      deps: h.deps,
      contact: fakeContact(),
      conversation: fakeConversation(),
      scope: {},
      stepKey: flowStepKey(run.id, 5),
    };
  };

  it("payment_link hands ctx.stepKey to createPaymentLink", async () => {
    const seen: unknown[] = [];
    const crm: CrmPort = {
      createPaymentLink: async (_run, _input, opts) => {
        seen.push(opts);
        return { ok: true, requestId: "req-1" };
      },
    };
    const ctx = ctxFor(harness({ crm }), "payment_link", {
      invoice_number: "INV-1",
      amount: "10.00",
    });
    expect(await EXECUTORS.payment_link(ctx)).toMatchObject({ kind: "next" });
    expect(seen).toEqual([{ stepKey: flowStepKey(ctx.run.id, 5) }]);
  });

  it("book_appointment hands ctx.stepKey to bookAppointment", async () => {
    const seen: unknown[] = [];
    const crm: CrmPort = {
      bookAppointment: async (_run, _input, opts) => {
        seen.push(opts);
        return { id: "appt-1", created: true };
      },
    };
    const ctx = ctxFor(harness({ crm }), "book_appointment", {
      service_id: "00000000-0000-4000-8000-0000000000b2",
      specialist_id: "00000000-0000-4000-8000-0000000000b3",
      location_id: "00000000-0000-4000-8000-0000000000b4",
      starts_at: "2026-10-20T08:00:00.000Z",
      notify: true,
    });
    expect(await EXECUTORS.book_appointment(ctx)).toMatchObject({
      kind: "next",
      vars: { appointment_id: "appt-1" },
    });
    expect(seen).toEqual([{ stepKey: flowStepKey(ctx.run.id, 5) }]);
  });

  it("a Book appointment step replayed after a crash books once (the port answers the key with its booking)", async () => {
    const booked = new Map<string, string>();
    const crm: CrmPort = {
      bookAppointment: async (_run, _input, opts) => {
        const earlier = booked.get(opts.stepKey);
        if (earlier) return { id: earlier, created: false };
        booked.set(opts.stepKey, `appt-${booked.size + 1}`);
        return { id: `appt-${booked.size}`, created: true };
      },
    };
    const h = harness({ crm });
    h.store.addFlow(
      graph(
        [
          node("t", "trigger"),
          node("b", "book_appointment", {
            service_id: "00000000-0000-4000-8000-0000000000b2",
            specialist_id: "00000000-0000-4000-8000-0000000000b3",
            location_id: "00000000-0000-4000-8000-0000000000b4",
            starts_at: "2026-10-20T08:00:00.000Z",
          }),
        ],
        [edge("t", "b")],
      ),
    );
    const id = await start(h);
    await advance(h.deps, id);
    crashBeforeStepRecorded(h);
    await expect(advance(h.deps, id)).rejects.toThrow("connection lost");
    await advance(h.deps, id);
    expect([...booked.entries()]).toEqual([[flowStepKey(id, 2), "appt-1"]]);
    expect(h.store.steps.find((s) => s.node_id === "b")!.output?.id).toBe("appt-1");
    expect(h.store.runs.get(id)!.context.vars.appointment_id).toBe("appt-1");
  });
});

// ---------------------------------------------------------------------------
// queueOutbound and messages.flow_step_key (a minimal stand-in for the supabase-js admin client)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function fakeAdmin() {
  const messages: Row[] = [];
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  let n = 0;
  const admin = {
    from(table: string) {
      if (table === "conversations") {
        return { update: () => ({ eq: async () => ({ data: null, error: null }) }) };
      }
      if (table !== "messages") throw new Error(`unexpected table ${table}`);
      return {
        insert(row: Row) {
          return {
            select: () => ({
              single: async () => {
                const clash =
                  (row.flow_step_key &&
                    messages.some((m) => m.flow_step_key === row.flow_step_key)) ||
                  (row.retry_of_message_id &&
                    messages.some((m) => m.retry_of_message_id === row.retry_of_message_id));
                if (clash)
                  return {
                    data: null,
                    error: { code: "23505", message: "duplicate key value" },
                  };
                const saved = {
                  ...row,
                  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
                  wa_message_id: null,
                };
                messages.push(saved);
                return { data: saved, error: null };
              },
            }),
          };
        },
        select() {
          const filters: Array<[string, unknown]> = [];
          const q = {
            eq(col: string, v: unknown) {
              filters.push([col, v]);
              return q;
            },
            async maybeSingle() {
              const hit = messages.filter((m) => filters.every(([c, v]) => m[c] === v));
              return { data: hit[0] ?? null, error: null };
            },
          };
          return q;
        },
      };
    },
    async rpc(fn: string, args: unknown) {
      rpcCalls.push({ fn, args });
      return { data: false, error: null };
    },
  };
  return { admin: admin as unknown as AdminClient, messages, rpcCalls };
}

const input = (over: Partial<Parameters<typeof queueOutbound>[1]> = {}) => ({
  orgId: ORG,
  conversationId: CONV,
  spec: { type: "text" as const, body: "Hello" },
  body: "Hello",
  sentByUserId: null,
  flowRunId: "00000000-0000-4000-8000-0000000000a1",
  priority: false,
  ...over,
});

describe("queueOutbound with a flow step key", () => {
  beforeEach(() => enqueue.mockClear());

  it("stores the key on the message and queues it once", async () => {
    const { admin, messages } = fakeAdmin();
    const m = await queueOutbound(admin, input({ flowStepKey: "run-a:2" }));
    expect(messages).toHaveLength(1);
    expect(messages[0]!.flow_step_key).toBe("run-a:2");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith("outbound", { message_id: m.id });
  });

  it("a replay with the same key returns the first message and only asks SQL to requeue it if lost", async () => {
    const { admin, messages, rpcCalls } = fakeAdmin();
    const first = await queueOutbound(admin, input({ flowStepKey: "run-a:2" }));
    const again = await queueOutbound(
      admin,
      input({ flowStepKey: "run-a:2", spec: { type: "text", body: "Hello (changed)" } }),
    );
    expect(again.id).toBe(first.id);
    expect(messages).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    // requeue_lost_flow_message claims and queues in one transaction (tests/db/flow-step-send-key.test.ts); it found a job.
    expect(rpcCalls).toEqual([
      { fn: "requeue_lost_flow_message", args: { p_message_id: first.id, p_queue: "outbound" } },
    ]);
  });

  it("a still-queued message is handed to the atomic SQL claim, never enqueued from TypeScript", async () => {
    const { admin, messages, rpcCalls } = fakeAdmin();
    messages.push({
      id: "00000000-0000-4000-8000-0000000000aa",
      org_id: ORG,
      flow_step_key: "run-a:2",
      status: "queued",
      wa_message_id: null,
    });
    const again = await queueOutbound(admin, input({ flowStepKey: "run-a:2" }));
    expect(again.id).toBe("00000000-0000-4000-8000-0000000000aa");
    expect(messages).toHaveLength(1);
    expect(enqueue).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([
      {
        fn: "requeue_lost_flow_message",
        args: { p_message_id: "00000000-0000-4000-8000-0000000000aa", p_queue: "outbound" },
      },
    ]);
  });

  it("never re-queues a message that is sending, sent or failed", async () => {
    for (const status of ["sending", "sent", "failed"]) {
      const { admin, messages, rpcCalls } = fakeAdmin();
      messages.push({
        id: "00000000-0000-4000-8000-0000000000ab",
        org_id: ORG,
        flow_step_key: "run-b:3",
        status,
        wa_message_id: status === "sending" ? null : status === "sent" ? "wamid.x" : null,
      });
      const again = await queueOutbound(admin, input({ flowStepKey: "run-b:3" }));
      expect(again.id).toBe("00000000-0000-4000-8000-0000000000ab");
      expect(rpcCalls).toEqual([]);
    }
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not look up another organisation's message with the same key", async () => {
    const { admin, messages } = fakeAdmin();
    messages.push({
      id: "00000000-0000-4000-8000-0000000000ac",
      org_id: "00000000-0000-4000-8000-000000000002",
      flow_step_key: "run-c:2",
      status: "sent",
      wa_message_id: "wamid.y",
    });
    await expect(queueOutbound(admin, input({ flowStepKey: "run-c:2" }))).rejects.toThrow(
      /queueOutbound: duplicate key/,
    );
  });

  it("messages without a key are unaffected; the retry pattern still throws RetryExistsError", async () => {
    const { admin, messages } = fakeAdmin();
    await queueOutbound(admin, input());
    await queueOutbound(admin, input());
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.flow_step_key === null)).toBe(true);
    const retryOf = {
      messageId: "00000000-0000-4000-8000-0000000000ad",
      attempt: 1,
      originAt: "2026-10-09T08:00:00.000Z",
    };
    await queueOutbound(admin, input({ retryOf }));
    await expect(queueOutbound(admin, input({ retryOf }))).rejects.toBeInstanceOf(RetryExistsError);
  });
});
