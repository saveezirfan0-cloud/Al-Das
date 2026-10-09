import { describe, expect, it } from "vitest";

import { and, cond } from "@/lib/filters/ast";
import { nextNodeId, validateGraph } from "@/lib/flow-engine/graph";
import { emptyGraph, handlesFor, type FlowGraph } from "@/lib/flow-engine/types";

const n = (id: string, type: string, data: Record<string, unknown> = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data,
});
const e = (source: string, target: string, sourceHandle?: string) => ({
  id: `${source}-${target}-${sourceHandle ?? ""}`,
  source,
  target,
  sourceHandle,
});
const trig = { triggerType: "conversation_opened" as const };
const g = (nodes: unknown[], edges: unknown[]) => ({ nodes, edges }) as unknown as FlowGraph;

describe("validateGraph", () => {
  it("accepts a minimal flow", () => {
    const r = validateGraph(
      g(
        [n("trigger", "trigger"), n("m", "message", { text: "Hi {contact.first_name}" })],
        [e("trigger", "m")],
      ),
      trig,
    );
    expect(r.ok).toBe(true);
    expect(r.errors).toBe(0);
  });

  it("requires exactly one connected trigger", () => {
    expect(
      validateGraph(g([n("m", "message", { text: "x" })], []), trig).issues.some((i) =>
        /no trigger/i.test(i.message),
      ),
    ).toBe(true);
    expect(validateGraph(g([n("trigger", "trigger"), n("t2", "trigger")], []), trig).ok).toBe(
      false,
    );
    expect(
      validateGraph(emptyGraph(), trig).issues.some((i) => /Connect the trigger/.test(i.message)),
    ).toBe(true);
  });

  it("rejects bad node config with the node id", () => {
    const r = validateGraph(
      g([n("trigger", "trigger"), n("m", "message", { text: "" })], [e("trigger", "m")]),
      trig,
    );
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.nodeId === "m")?.severity).toBe("error");
  });

  it("enforces Meta's button and list limits on questions", () => {
    const opts = (k: number) =>
      Array.from({ length: k }, (_, i) => ({ id: `o${i}`, title: `Option ${i}` }));
    const q = (data: Record<string, unknown>) =>
      validateGraph(
        g(
          [n("trigger", "trigger"), n("q", "question", { text: "?", variable: "answer", ...data })],
          [e("trigger", "q")],
        ),
        trig,
      );
    expect(q({ kind: "buttons", options: opts(3) }).ok).toBe(true);
    expect(q({ kind: "buttons", options: opts(4) }).ok).toBe(false);
    expect(
      q({ kind: "buttons", options: [{ id: "a", title: "A button title that is far too long" }] })
        .ok,
    ).toBe(false);
    expect(q({ kind: "list", options: opts(10) }).ok).toBe(true);
    expect(q({ kind: "list", options: opts(11) }).ok).toBe(false);
    expect(q({ kind: "text", options: opts(1) }).ok).toBe(false);
    expect(q({ kind: "text", options: [], variable: "1bad" }).ok).toBe(false);
  });

  it("checks that arrows leave through real exits and point at real nodes", () => {
    const base = [
      n("trigger", "trigger"),
      n("b", "branch", { conditions: { include: and(cond("message.text", "contains", "x")) } }),
      n("m", "message", { text: "x" }),
    ];
    expect(validateGraph(g(base, [e("trigger", "b"), e("b", "m", "true")]), trig).ok).toBe(true);
    expect(validateGraph(g(base, [e("trigger", "b"), e("b", "m", "inside")]), trig).ok).toBe(false);
    expect(validateGraph(g(base, [e("trigger", "b"), e("b", "ghost", "true")]), trig).ok).toBe(
      false,
    );
    expect(
      validateGraph(g(base, [e("trigger", "b"), e("b", "m", "true"), e("b", "m", "true")]), trig)
        .ok,
    ).toBe(false);
    expect(validateGraph(g(base, [e("trigger", "b"), e("m", "trigger")]), trig).ok).toBe(false);
  });

  it("warns about unreachable nodes, dangling branch exits and missing fallbacks", () => {
    const r = validateGraph(
      g(
        [
          n("trigger", "trigger"),
          n("b", "branch", { conditions: { include: and(cond("message.text", "contains", "x")) } }),
          n("orphan", "message", { text: "never" }),
          n("q", "quick_reply", { text: "?", options: [{ id: "y", title: "Yes" }] }),
        ],
        [e("trigger", "b"), e("b", "q", "true")],
      ),
      trig,
    );
    const msgs = r.issues
      .filter((i) => i.severity === "warning")
      .map((i) => i.message)
      .join("\n");
    expect(msgs).toMatch(/not connected to the trigger/);
    expect(msgs).toMatch(/"false" exit of Branch/);
    expect(msgs).toMatch(/no "fallback" exit/);
  });

  it("warns on unknown fields and filters and on variables that are never set", () => {
    const r = validateGraph(
      g(
        [
          n("trigger", "trigger"),
          n("m", "message", { text: "{bogus.x} {contact.first_name|shout} {vars.never}" }),
        ],
        [e("trigger", "m")],
      ),
      trig,
    );
    const msgs = r.issues.map((i) => i.message).join("\n");
    expect(msgs).toMatch(/"\{bogus.x\}" is not a known field/);
    expect(msgs).toMatch(/Unknown filter "shout"/);
    expect(msgs).toMatch(/Variable "never" is never set/);
    expect(r.ok).toBe(true);
  });

  it("knows variables saved by questions and defined in the manager", () => {
    const r = validateGraph(
      g(
        [
          n("trigger", "trigger"),
          n("q", "question", { text: "Name?", kind: "text", variable: "who" }),
          n("m", "message", { text: "{vars.who} {vars.clinic}" }),
        ],
        [e("trigger", "q"), e("q", "m")],
      ),
      { ...trig, knownVariables: ["clinic"] },
    );
    expect(r.issues.some((i) => /never set/.test(i.message))).toBe(false);
  });

  it("recurring flows need a valid schedule; conversation nodes get a warning without a conversation", () => {
    const graph = g(
      [n("trigger", "trigger"), n("m", "message", { text: "hi" })],
      [e("trigger", "m")],
    );
    expect(validateGraph(graph, { triggerType: "recurring", triggerConfig: {} }).ok).toBe(false);
    const ok = validateGraph(graph, {
      triggerType: "recurring",
      triggerConfig: { cron: "0 9 * * *" },
    });
    expect(ok.ok).toBe(true);
    expect(ok.warnings).toBeGreaterThan(0);
  });

  it("warns about wait-free loops", () => {
    const r = validateGraph(
      g(
        [
          n("trigger", "trigger"),
          n("a", "add_comment", { text: "x" }),
          n("b", "add_comment", { text: "y" }),
        ],
        [e("trigger", "a"), e("a", "b"), e("b", "a")],
      ),
      trig,
    );
    expect(r.issues.some((i) => /loop/.test(i.message))).toBe(true);
    const withWait = validateGraph(
      g(
        [
          n("trigger", "trigger"),
          n("a", "wait", { amount: 5, unit: "minutes" }),
          n("b", "add_comment", { text: "y" }),
        ],
        [e("trigger", "a"), e("a", "b"), e("b", "a")],
      ),
      trig,
    );
    expect(withWait.issues.some((i) => /loop/.test(i.message))).toBe(false);
  });

  it("returns an error, not an exception, for garbage input", () => {
    expect(validateGraph("nope", trig).ok).toBe(false);
    expect(validateGraph({ nodes: [{ id: "x" }], edges: [] }, trig).ok).toBe(false);
  });
});

describe("graph helpers", () => {
  it("nextNodeId follows the exact handle only", () => {
    const graph = g([], [e("a", "b"), e("a", "c", "fallback"), e("q", "d", "option:yes")]);
    expect(nextNodeId(graph, "a", "default")).toBe("b");
    expect(nextNodeId(graph, "a", "fallback")).toBe("c");
    expect(nextNodeId(graph, "a", "true")).toBeNull();
    expect(nextNodeId(graph, "q", "option:yes")).toBe("d");
  });

  it("handlesFor lists option exits", () => {
    expect(handlesFor("question", { options: [{ id: "a" }, { id: "b" }] })).toEqual([
      "default",
      "option:a",
      "option:b",
      "fallback",
    ]);
    expect(handlesFor("branch")).toEqual(["true", "false"]);
    expect(handlesFor("end_flow")).toEqual([]);
    expect(handlesFor("office_hours")).toEqual(["inside", "outside"]);
  });
});
