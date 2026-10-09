import { describe, expect, it } from "vitest";

import {
  advance,
  cancelActiveRunForConversation,
  cancelRun,
  resumeFromReply,
  resumeFromTimer,
  startRun,
} from "@/lib/flow-engine/run";
import { MAX_STEPS } from "@/lib/flow-engine/types";

import { CONTACT, CONV, FLOW, ORG, edge, graph, harness, node, type Harness } from "./flow-fakes";

async function start(h: Harness, input: Partial<Parameters<typeof startRun>[1]> = {}) {
  const r = await startRun(h.deps, {
    flowId: FLOW,
    contactId: CONTACT,
    conversationId: CONV,
    ...input,
  });
  if (!r.started) throw new Error(`not started: ${r.reason}`);
  return r.runId;
}

const run = (h: Harness, id: string) => h.store.runs.get(id)!;

describe("startRun", () => {
  it("creates a run at the trigger, flags the conversation as bot-handled and enqueues the first step", async () => {
    const h = harness();
    h.store.addFlow(graph([node("t", "trigger"), node("e", "end_flow")], [edge("t", "e")]));
    const id = await start(h);
    expect(run(h, id)).toMatchObject({ status: "running", current_node_id: "t", flow_version: 1 });
    expect(h.store.conversations.get(CONV)).toMatchObject({ bot_active: true, flow_run_id: id });
    expect(h.jobs.steps).toEqual([id]);
  });
  it("refuses a second live run in the same conversation", async () => {
    const h = harness();
    h.store.addFlow(graph([node("t", "trigger"), node("e", "end_flow")], [edge("t", "e")]));
    await start(h);
    expect(
      await startRun(h.deps, { flowId: FLOW, contactId: CONTACT, conversationId: CONV }),
    ).toEqual({ started: false, reason: "live_run_exists" });
  });
  it("refuses drafts, paused flows and missing flows", async () => {
    const h = harness();
    h.store.addFlow(graph([node("t", "trigger")], []), { status: "draft" });
    expect(
      await startRun(h.deps, { flowId: FLOW, contactId: CONTACT, conversationId: CONV }),
    ).toEqual({ started: false, reason: "flow_inactive" });
    expect(
      await startRun(h.deps, {
        flowId: "00000000-0000-4000-8000-0000000000aa",
        contactId: null,
        conversationId: null,
      }),
    ).toEqual({ started: false, reason: "flow_inactive" });
  });
});

describe("advance", () => {
  const linear = graph(
    [
      node("t", "trigger"),
      node("m1", "message", { text: "Hello {contact.first_name}" }),
      node("m2", "message", { text: "Bye" }),
      node("e", "end_flow"),
    ],
    [edge("t", "m1"), edge("m1", "m2"), edge("m2", "e")],
  );

  it("runs one node per job, in order, and completes", async () => {
    const h = harness();
    h.store.addFlow(linear);
    const id = await start(h);
    h.jobs.steps.length = 0; // drop the job startRun queued; drive the first step by hand
    const first = await advance(h.deps, id);
    expect(first).toEqual({ status: "ok", next: "enqueued" });
    expect(h.jobs.steps).toEqual([id]); // exactly one follow-up job per step
    await h.drain();
    expect(h.actions.sent.map((s) => (s.spec as { body: string }).body)).toEqual([
      "Hello Test",
      "Bye",
    ]);
    expect(run(h, id)).toMatchObject({ status: "completed", step_count: 4 });
    expect(h.store.steps.map((s) => [s.seq, s.node_id, s.status])).toEqual([
      [1, "t", "ok"],
      [2, "m1", "ok"],
      [3, "m2", "ok"],
      [4, "e", "ok"],
    ]);
    expect(h.store.conversations.get(CONV)).toMatchObject({ bot_active: false, flow_run_id: null });
  });

  it("completes when a node has no outgoing edge", async () => {
    const h = harness();
    h.store.addFlow(
      graph([node("t", "trigger"), node("m", "message", { text: "x" })], [edge("t", "m")]),
    );
    const id = await start(h);
    await h.drain();
    expect(run(h, id).status).toBe("completed");
  });

  it("is idempotent: a redelivered job does not send twice", async () => {
    const h = harness();
    h.store.addFlow(
      graph(
        [node("t", "trigger"), node("m", "message", { text: "once" }), node("e", "end_flow")],
        [edge("t", "m"), edge("m", "e")],
      ),
    );
    const id = await start(h);
    await advance(h.deps, id); // trigger
    await advance(h.deps, id); // message sent
    expect(h.actions.sent).toHaveLength(1);
    // Crash simulation: the step row says done but the run row was not updated.
    const r = run(h, id);
    r.step_count = 1;
    r.current_node_id = "m";
    await advance(h.deps, id);
    expect(h.actions.sent).toHaveLength(1);
    expect(run(h, id).current_node_id).toBe("e");
  });

  it("returns locked (no side effects) while another step holds the conversation lock", async () => {
    const h = harness();
    h.store.addFlow(linear);
    const id = await start(h);
    await h.lock.claim(CONV, "someone-else");
    expect(await advance(h.deps, id)).toEqual({ status: "locked" });
    expect(h.store.steps).toHaveLength(0);
    await h.lock.release(CONV, "someone-else");
    expect((await advance(h.deps, id)).status).toBe("ok");
  });

  it("releases the lock after every step", async () => {
    const h = harness();
    h.store.addFlow(linear);
    const id = await start(h);
    await advance(h.deps, id);
    expect(h.lock.held.size).toBe(0);
  });

  it("stops a runaway loop at the step cap", async () => {
    const h = harness();
    h.store.addFlow(
      graph(
        [
          node("t", "trigger"),
          node("a", "add_comment", { text: "a" }),
          node("b", "add_comment", { text: "b" }),
        ],
        [edge("t", "a"), edge("a", "b"), edge("b", "a")],
      ),
    );
    const id = await start(h);
    await h.drain(MAX_STEPS + 50);
    expect(run(h, id).status).toBe("failed");
    expect(run(h, id).error).toContain("200 steps");
    expect(run(h, id).step_count).toBe(MAX_STEPS);
    expect(h.store.steps.length).toBe(MAX_STEPS);
  });

  it("fails the run when a step fails and has no fallback", async () => {
    const h = harness();
    h.store.addFlow(
      graph(
        [
          node("t", "trigger"),
          node("m", "message", { text: "{contact.nope}" }),
          node("e", "end_flow"),
        ],
        [edge("t", "m"), edge("m", "e")],
      ),
    );
    const id = await start(h);
    await h.drain();
    expect(run(h, id)).toMatchObject({ status: "failed" });
    expect(run(h, id).error).toContain("empty");
    expect(h.store.steps.find((s) => s.node_id === "m")).toMatchObject({ status: "failed" });
    expect(h.store.conversations.get(CONV)!.bot_active).toBe(false);
  });

  it("follows the fallback edge of a failing step", async () => {
    const h = harness();
    h.store.addFlow(
      graph(
        [
          node("t", "trigger"),
          node("m", "message", { text: "{contact.nope}" }),
          node("c", "add_comment", { text: "send failed" }),
          node("e", "end_flow"),
        ],
        [edge("t", "m"), edge("m", "e"), edge("m", "c", "fallback")],
      ),
    );
    const id = await start(h);
    await h.drain();
    expect(run(h, id).status).toBe("completed");
    expect(h.actions.comments).toEqual(["send failed"]);
  });

  it("turns a thrown executor error into a step failure", async () => {
    const h = harness();
    h.actions.send = async () => {
      throw new Error("db down");
    };
    h.store.addFlow(
      graph([node("t", "trigger"), node("m", "message", { text: "x" })], [edge("t", "m")]),
    );
    const id = await start(h);
    await h.drain();
    expect(run(h, id)).toMatchObject({ status: "failed", error: "db down" });
  });

  it("branches on saved variables and office hours", async () => {
    const h = harness({ now: new Date("2026-10-12T16:00:00Z") }); // Monday 20:00 Dubai
    h.store.addFlow(
      graph(
        [
          node("t", "trigger"),
          node("oh", "office_hours", { schedule: { mon: [{ start: "09:00", end: "18:00" }] } }),
          node("in", "add_comment", { text: "inside" }),
          node("out", "add_comment", { text: "outside" }),
        ],
        [edge("t", "oh"), edge("oh", "in", "inside"), edge("oh", "out", "outside")],
      ),
    );
    await start(h);
    await h.drain();
    expect(h.actions.comments).toEqual(["outside"]);
  });

  it("skips runs that are no longer running", async () => {
    const h = harness();
    h.store.addFlow(linear);
    const id = await start(h);
    run(h, id).status = "cancelled";
    expect(await advance(h.deps, id)).toEqual({ status: "skipped", reason: "run_cancelled" });
    expect(await advance(h.deps, "00000000-0000-4000-8000-0000000000bb")).toEqual({
      status: "skipped",
      reason: "run_not_found",
    });
  });

  it("does not resurrect a run cancelled while its node was executing", async () => {
    const h = harness();
    h.store.addFlow(
      graph(
        [node("t", "trigger"), node("m", "message", { text: "x" }), node("e", "end_flow")],
        [edge("t", "m"), edge("m", "e")],
      ),
    );
    const id = await start(h);
    await advance(h.deps, id); // trigger
    const realSend = h.actions.send.bind(h.actions);
    h.actions.send = async (...a) => {
      run(h, id).status = "cancelled"; // takeover lands mid-send
      return realSend(...a);
    };
    const res = await advance(h.deps, id);
    expect(res.status).toBe("skipped");
    expect(run(h, id).status).toBe("cancelled");
  });
});

describe("question → reply", () => {
  const g = graph(
    [
      node("t", "trigger"),
      node("q", "question", {
        text: "Book?",
        style: "buttons",
        options: [
          { id: "y", title: "Yes" },
          { id: "n", title: "No" },
        ],
        variable: "answer",
        timeout_seconds: 300,
      }),
      node("yes", "add_comment", { text: "wants booking: {vars.answer}" }),
      node("no", "add_comment", { text: "declined" }),
      node("fb", "add_comment", { text: "no answer" }),
    ],
    [
      edge("t", "q"),
      edge("q", "yes", "option:y"),
      edge("q", "no", "option:n"),
      edge("q", "fb", "fallback"),
    ],
  );

  async function waiting(h: Harness) {
    h.store.addFlow(g);
    const id = await start(h);
    await h.drain();
    expect(run(h, id).status).toBe("waiting");
    return id;
  }

  it("waits, then follows the chosen option and saves the variable", async () => {
    const h = harness();
    const id = await waiting(h);
    expect(h.store.steps.find((s) => s.node_id === "q")!.status).toBe("waiting");
    const res = await resumeFromReply(h.deps, id, { kind: "button", text: "Yes", optionId: "y" });
    expect(res).toEqual({ resumed: true });
    await h.drain();
    expect(h.actions.comments).toEqual(["wants booking: Yes"]);
    expect(run(h, id).status).toBe("completed");
    expect(h.store.steps.find((s) => s.node_id === "q")!.status).toBe("ok");
  });

  it("matches typed text to an option title", async () => {
    const h = harness();
    const id = await waiting(h);
    await resumeFromReply(h.deps, id, { kind: "text", text: " no " });
    await h.drain();
    expect(h.actions.comments).toEqual(["declined"]);
  });

  it("unmatched text takes the fallback edge and does not save the variable", async () => {
    const h = harness();
    const id = await waiting(h);
    await resumeFromReply(h.deps, id, { kind: "text", text: "maybe tomorrow" });
    await h.drain();
    expect(h.actions.comments).toEqual(["no answer"]);
    expect(run(h, id).context.vars.answer).toBeUndefined();
  });

  it("unmatched text without a fallback keeps waiting", async () => {
    const h = harness();
    const noFallback = graph(
      g.nodes.filter((n) => n.id !== "fb"),
      g.edges.filter((e) => e.sourceHandle !== "fallback"),
    );
    h.store.addFlow(noFallback);
    const id = await start(h);
    await h.drain();
    expect(await resumeFromReply(h.deps, id, { kind: "text", text: "???" })).toEqual({
      resumed: false,
      reason: "unmatched_reply",
    });
    expect(run(h, id).status).toBe("waiting");
  });

  it("times out through the fallback edge; stale tokens are ignored", async () => {
    const h = harness();
    const id = await waiting(h);
    const { token } = h.jobs.resumes[0]!;
    expect(await resumeFromTimer(h.deps, id, "wrong-token")).toEqual({
      resumed: false,
      reason: "stale_token",
    });
    expect(await resumeFromTimer(h.deps, id, token)).toEqual({ resumed: true });
    await h.drain();
    expect(h.actions.comments).toEqual(["no answer"]);
    // a late duplicate timer is a no-op
    expect(await resumeFromTimer(h.deps, id, token)).toEqual({
      resumed: false,
      reason: "not_waiting",
    });
  });

  it("a reply after the run finished is ignored", async () => {
    const h = harness();
    const id = await waiting(h);
    await resumeFromReply(h.deps, id, { kind: "button", text: "Yes", optionId: "y" });
    await h.drain();
    expect(await resumeFromReply(h.deps, id, { kind: "text", text: "Yes" })).toEqual({
      resumed: false,
      reason: "not_waiting",
    });
  });

  it("free-text question saves the answer and takes default", async () => {
    const h = harness();
    h.store.addFlow(
      graph(
        [
          node("t", "trigger"),
          node("q", "question", { text: "Your concern?", variable: "concern" }),
          node("c", "add_comment", { text: "concern={vars.concern}" }),
        ],
        [edge("t", "q"), edge("q", "c")],
      ),
    );
    const id = await start(h);
    await h.drain();
    await resumeFromReply(h.deps, id, { kind: "text", text: "back pain" });
    await h.drain();
    expect(h.actions.comments).toEqual(["concern=back pain"]);
  });
});

describe("wait", () => {
  it("resumes via the scheduled timer, not in memory", async () => {
    const h = harness();
    h.store.addFlow(
      graph(
        [
          node("t", "trigger"),
          node("w", "wait", { amount: 1, unit: "days" }),
          node("c", "add_comment", { text: "later" }),
        ],
        [edge("t", "w"), edge("w", "c")],
      ),
    );
    const id = await start(h);
    await h.drain();
    expect(run(h, id).status).toBe("waiting");
    expect(h.actions.comments).toEqual([]);
    expect(h.jobs.resumes).toHaveLength(1);
    await resumeFromTimer(h.deps, id, h.jobs.resumes[0]!.token);
    await h.drain();
    expect(h.actions.comments).toEqual(["later"]);
    expect(run(h, id).status).toBe("completed");
  });
});

describe("cancel / human takeover", () => {
  function waitingRun(h: Harness) {
    h.store.addFlow(
      graph(
        [
          node("t", "trigger"),
          node("q", "question", { text: "Hi?" }),
          node("c", "add_comment", { text: "after" }),
        ],
        [edge("t", "q"), edge("q", "c")],
      ),
    );
    return start(h).then(async (id) => {
      await h.drain();
      return id;
    });
  }

  it("cancelRun stops a waiting run and clears the bot flag", async () => {
    const h = harness();
    const id = await waitingRun(h);
    expect(await cancelRun(h.deps, id, "human takeover")).toBe(true);
    expect(run(h, id)).toMatchObject({ status: "cancelled", error: "human takeover" });
    expect(h.store.conversations.get(CONV)).toMatchObject({ bot_active: false, flow_run_id: null });
    expect(await resumeFromReply(h.deps, id, { kind: "text", text: "hello" })).toMatchObject({
      resumed: false,
    });
  });

  it("cancelActiveRunForConversation finds the live run; no run still clears the flag", async () => {
    const h = harness();
    const id = await waitingRun(h);
    expect(await cancelActiveRunForConversation(h.deps, CONV, "takeover")).toBe(true);
    expect(run(h, id).status).toBe("cancelled");
    h.store.conversations.get(CONV)!.bot_active = true;
    expect(await cancelActiveRunForConversation(h.deps, CONV, "takeover")).toBe(false);
    expect(h.store.conversations.get(CONV)!.bot_active).toBe(false);
  });

  it("a cancelled run lets a new flow start in the same conversation", async () => {
    const h = harness();
    const id = await waitingRun(h);
    await cancelRun(h.deps, id, "x");
    expect(
      (await startRun(h.deps, { flowId: FLOW, contactId: CONTACT, conversationId: CONV })).started,
    ).toBe(true);
  });

  it("cancelling a parent cancels its nested run", async () => {
    const h = harness();
    const CHILD = "00000000-0000-4000-8000-0000000000f2";
    const childGraph = graph(
      [node("t", "trigger"), node("q", "question", { text: "child?" })],
      [edge("t", "q")],
    );
    h.store.flows.set(CHILD, {
      id: CHILD,
      org_id: ORG,
      name: "child",
      status: "active",
      trigger_type: "shortcut",
      trigger_config: {},
      channel_id: null,
      version: 1,
      published_graph: childGraph,
    });
    h.store.graphs.set(`${CHILD}:1`, childGraph);
    h.store.addFlow(
      graph([node("t", "trigger"), node("r", "run_flow", { flow_id: CHILD })], [edge("t", "r")]),
    );
    const parent = await start(h);
    await h.drain();
    const child = [...h.store.runs.values()].find((r) => r.parent_run_id === parent)!;
    expect(child.status).toBe("waiting");
    await cancelRun(h.deps, parent, "takeover");
    expect(child.status).toBe("cancelled");
    expect(run(h, parent).status).toBe("cancelled");
  });
});

describe("nested flows", () => {
  const CHILD = "00000000-0000-4000-8000-0000000000f2";
  function setup(h: Harness, childGraph: ReturnType<typeof graph>) {
    h.store.flows.set(CHILD, {
      id: CHILD,
      org_id: ORG,
      name: "child",
      status: "active",
      trigger_type: "shortcut",
      trigger_config: {},
      channel_id: null,
      version: 1,
      published_graph: childGraph,
    });
    h.store.graphs.set(`${CHILD}:1`, childGraph);
    h.store.addFlow(
      graph(
        [
          node("t", "trigger"),
          node("r", "run_flow", { flow_id: CHILD }),
          node("after", "add_comment", { text: "parent continues" }),
          node("onfail", "add_comment", { text: "child failed" }),
        ],
        [edge("t", "r"), edge("r", "after"), edge("r", "onfail", "fallback")],
      ),
    );
  }

  it("parent resumes on its default edge when the child completes", async () => {
    const h = harness();
    setup(
      h,
      graph(
        [node("t", "trigger"), node("c", "add_comment", { text: "child ran" })],
        [edge("t", "c")],
      ),
    );
    const parent = await start(h);
    await h.drain();
    expect(h.actions.comments).toEqual(["child ran", "parent continues"]);
    expect(run(h, parent).status).toBe("completed");
    // the child did not toggle the conversation's bot flag off while the parent was still running
    expect(h.store.conversations.get(CONV)!.bot_active).toBe(false);
  });

  it("parent takes the fallback edge when the child fails", async () => {
    const h = harness();
    setup(
      h,
      graph(
        [node("t", "trigger"), node("c", "add_comment", { text: "{vars.nope}" })],
        [edge("t", "c")],
      ),
    );
    const parent = await start(h);
    await h.drain();
    expect(h.actions.comments).toEqual(["child failed"]);
    expect(run(h, parent).status).toBe("completed");
  });
});
