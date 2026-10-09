import { describe, expect, it } from "vitest";

import type { StepInput } from "@/lib/flow-engine/executors";
import { firstNodeId, runStep, type RunState, type StepOutcome } from "@/lib/flow-engine/runner";
import { MAX_STEPS_PER_RUN, type FlowGraph } from "@/lib/flow-engine/types";
import { and, cond } from "@/lib/filters/ast";

import { fakePorts } from "./fake-ports";

const n = (id: string, type: string, data: Record<string, unknown> = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data,
});
const e = (source: string, target: string, sourceHandle?: string) => ({
  id: `${source}>${target}${sourceHandle ?? ""}`,
  source,
  target,
  sourceHandle,
});
const graph = (nodes: unknown[], edges: unknown[]) => ({ nodes, edges }) as unknown as FlowGraph;

const state = (over: Partial<RunState> = {}): RunState => ({
  currentNodeId: null,
  stepCount: 0,
  waitSeq: 0,
  vars: {},
  steps: {},
  context: {},
  ...over,
});

/** Drives a run to its next stopping point, like the job handler does. */
async function drive(g: FlowGraph, s: RunState, input: StepInput, ports = fakePorts()) {
  const trace: StepOutcome["trace"][] = [];
  let cur = s;
  let inp = input;
  for (let guard = 0; guard < 400; guard++) {
    const out = await runStep(g, cur, inp, () => ({
      scope: { vars: cur.vars, steps: cur.steps, contact: { first_name: "Sara" } },
      ports,
    }));
    trace.push(out.trace);
    cur = {
      ...cur,
      vars: out.vars,
      steps: out.steps,
      context: out.context,
      stepCount: out.trace.seq,
    };
    if (out.next.kind === "continue") {
      cur.currentNodeId = out.next.nodeId;
      inp = { type: "start" };
      continue;
    }
    return { out, trace, state: cur, ports };
  }
  throw new Error("runaway");
}

describe("runStep", () => {
  const linear = graph(
    [n("t", "trigger"), n("a", "message", { text: "one" }), n("b", "message", { text: "two" })],
    [e("t", "a"), e("a", "b")],
  );

  it("firstNodeId is the node after the trigger", () => {
    expect(firstNodeId(linear)).toBe("a");
    expect(firstNodeId(graph([n("t", "trigger")], []))).toBeNull();
  });

  it("walks a linear flow to completion, one trace row per node", async () => {
    const r = await drive(linear, state({ currentNodeId: "a" }), { type: "start" });
    expect(r.out.next.kind).toBe("completed");
    expect(r.trace.map((t) => [t.seq, t.nodeId, t.status])).toEqual([
      [1, "a", "ok"],
      [2, "b", "ok"],
    ]);
    expect(r.ports.calls.map((c) => c.args[0])).toEqual(["one", "two"]);
  });

  it("branches on conditions", async () => {
    const g = graph(
      [
        n("t", "trigger"),
        n("br", "branch", {
          conditions: { include: and(cond("contact.first_name", "eq", "Sara")) },
        }),
        n("y", "message", { text: "yes" }),
        n("no", "message", { text: "no" }),
      ],
      [e("t", "br"), e("br", "y", "true"), e("br", "no", "false")],
    );
    const r = await drive(g, state({ currentNodeId: "br" }), { type: "start" });
    expect(r.ports.calls.map((c) => c.args[0])).toEqual(["yes"]);
  });

  it("an unconnected exit ends the run normally", async () => {
    const g = graph(
      [
        n("t", "trigger"),
        n("br", "branch", {
          conditions: { include: and(cond("contact.first_name", "eq", "Nobody")) },
        }),
      ],
      [e("t", "br")],
    );
    const r = await drive(g, state({ currentNodeId: "br" }), { type: "start" });
    expect(r.out.next.kind).toBe("completed");
  });

  it("question: asks, waits with a token, resumes by option and keeps variables", async () => {
    const g = graph(
      [
        n("t", "trigger"),
        n("q", "question", {
          text: "Pick",
          kind: "buttons",
          options: [
            { id: "yes", title: "Yes" },
            { id: "no", title: "No" },
          ],
          variable: "answer",
          timeoutMinutes: 10,
        }),
        n("y", "message", { text: "great {vars.answer}" }),
        n("fb", "message", { text: "sorry" }),
      ],
      [e("t", "q"), e("q", "y", "option:yes"), e("q", "fb", "fallback")],
    );
    const asked = await drive(g, state({ currentNodeId: "q", waitSeq: 4 }), { type: "start" });
    expect(asked.out.next).toEqual({
      kind: "wait",
      wait: { type: "reply", node_id: "q", token: 5, expires_at: "2026-10-12T08:10:00.000Z" },
    });
    expect(asked.out.trace.status).toBe("waiting");

    const answered = await drive(
      g,
      { ...asked.state, currentNodeId: "q", waitSeq: 5 },
      { type: "reply", reply: { type: "interactive", text: "Yes", interactiveId: "yes" } },
    );
    expect(answered.out.next.kind).toBe("completed");
    expect(answered.state.vars).toMatchObject({ answer: "Yes", answer_id: "yes" });
    expect(answered.ports.calls.at(-1)?.args[0]).toBe("great Yes");

    const timedOut = await drive(g, { ...asked.state, currentNodeId: "q" }, { type: "timeout" });
    expect(timedOut.ports.calls.at(-1)?.args[0]).toBe("sorry");
  });

  it("an option without its own arrow falls back to the default exit", async () => {
    const g = graph(
      [
        n("t", "trigger"),
        n("q", "quick_reply", { text: "?", options: [{ id: "a", title: "A" }] }),
        n("m", "message", { text: "next" }),
      ],
      [e("t", "q"), e("q", "m")],
    );
    const r = await drive(g, state({ currentNodeId: "q" }), {
      type: "reply",
      reply: { type: "interactive", text: "A", interactiveId: "a" },
    });
    expect(r.ports.calls.map((c) => c.args[0])).toEqual(["next"]);
  });

  it("wait: parks until the timer, then continues", async () => {
    const g = graph(
      [
        n("t", "trigger"),
        n("w", "wait", { amount: 1, unit: "days" }),
        n("m", "message", { text: "later" }),
      ],
      [e("t", "w"), e("w", "m")],
    );
    const parked = await drive(g, state({ currentNodeId: "w" }), { type: "start" });
    expect(parked.out.next).toMatchObject({
      kind: "wait",
      wait: { type: "time", node_id: "w", expires_at: "2026-10-13T08:00:00.000Z" },
    });
    const done = await drive(g, { ...parked.state, currentNodeId: "w" }, { type: "time" });
    expect(done.out.next.kind).toBe("completed");
    expect(done.ports.calls.map((c) => c.args[0])).toEqual(["later"]);
  });

  it("run_flow hands over", async () => {
    const g = graph(
      [n("t", "trigger"), n("r", "run_flow", { flowId: "3b9d5c1e-6b6e-4a52-8b27-6d6b0d7c3a11" })],
      [e("t", "r")],
    );
    const r = await drive(g, state({ currentNodeId: "r" }), { type: "start" });
    expect(r.out.next).toEqual({
      kind: "transfer",
      flowId: "3b9d5c1e-6b6e-4a52-8b27-6d6b0d7c3a11",
    });
  });

  it("end_flow completes even when more nodes follow", async () => {
    const g = graph(
      [n("t", "trigger"), n("x", "end_flow"), n("m", "message", { text: "never" })],
      [e("t", "x"), e("x", "m")],
    );
    const r = await drive(g, state({ currentNodeId: "x" }), { type: "start" });
    expect(r.out.next.kind).toBe("completed");
    expect(r.ports.calls).toEqual([]);
  });

  it("a node error fails the run with the reason and the trace row", async () => {
    const g = graph([n("t", "trigger"), n("m", "message", { text: "hi" })], [e("t", "m")]);
    const r = await drive(
      g,
      state({ currentNodeId: "m" }),
      { type: "start" },
      fakePorts({ hasConversation: false }),
    );
    expect(r.out.next).toEqual({
      kind: "failed",
      error: expect.stringMatching(/needs a conversation/),
    });
    expect(r.out.trace).toMatchObject({ status: "failed", nodeId: "m", error: expect.any(String) });
  });

  it("transient errors (not FlowNodeError) propagate so the job retries", async () => {
    const g = graph([n("t", "trigger"), n("m", "message", { text: "hi" })], [e("t", "m")]);
    const ports = fakePorts({
      sendText: async () => {
        throw new Error("db down");
      },
    });
    await expect(drive(g, state({ currentNodeId: "m" }), { type: "start" }, ports)).rejects.toThrow(
      "db down",
    );
  });

  it("api_action failure without a fallback arrow fails the run; with one it continues", async () => {
    const failing = fakePorts({ httpRequest: async () => ({ status: 503, text: "no" }) });
    const without = graph(
      [n("t", "trigger"), n("api", "api_action", { method: "GET", url: "https://example.org" })],
      [e("t", "api")],
    );
    expect(
      (await drive(without, state({ currentNodeId: "api" }), { type: "start" }, failing)).out.next,
    ).toMatchObject({ kind: "failed" });
    const withFb = graph(
      [
        n("t", "trigger"),
        n("api", "api_action", { method: "GET", url: "https://example.org" }),
        n("m", "message", { text: "handled" }),
      ],
      [e("t", "api"), e("api", "m", "fallback")],
    );
    const r = await drive(withFb, state({ currentNodeId: "api" }), { type: "start" }, failing);
    expect(r.out.next.kind).toBe("completed");
    expect(r.ports.calls.at(-1)?.args[0]).toBe("handled");
  });

  it("step outputs are available to later nodes", async () => {
    const g = graph(
      [
        n("t", "trigger"),
        n("api", "api_action", { method: "GET", url: "https://example.org" }),
        n("m", "message", { text: "id {steps.api.response.n}" }),
      ],
      [e("t", "api"), e("api", "m")],
    );
    const r = await drive(g, state({ currentNodeId: "api" }), { type: "start" });
    expect(r.ports.calls.at(-1)?.args[0]).toBe("id 3");
  });

  it("enquiry ids flow into the run context", async () => {
    const g = graph([n("t", "trigger"), n("en", "enquiry", { action: "create" })], [e("t", "en")]);
    const r = await drive(g, state({ currentNodeId: "en" }), { type: "start" });
    expect(r.state.context).toEqual({ enquiry_id: "enq-1" });
  });

  it("stops a loop at the step cap", async () => {
    const g = graph(
      [
        n("t", "trigger"),
        n("a", "add_comment", { text: "x" }),
        n("b", "add_comment", { text: "y" }),
      ],
      [e("t", "a"), e("a", "b"), e("b", "a")],
    );
    const r = await drive(g, state({ currentNodeId: "a" }), { type: "start" });
    expect(r.out.next).toEqual({
      kind: "failed",
      error: `Stopped after ${MAX_STEPS_PER_RUN} steps (the flow loops).`,
    });
    expect(r.trace.length).toBe(MAX_STEPS_PER_RUN + 1);
    expect(r.ports.calls.length).toBe(MAX_STEPS_PER_RUN);
  });

  it("fails when the current node was deleted from the graph", async () => {
    const r = await drive(linear, state({ currentNodeId: "gone" }), { type: "start" });
    expect(r.out.next).toMatchObject({
      kind: "failed",
      error: expect.stringMatching(/no longer exists/),
    });
  });
});
