import { describe, expect, it } from "vitest";

import { NODE_DEFS, defFor, outputsFor, searchNodes } from "@/lib/flow-engine/catalog";
import { hasErrors, validateGraph } from "@/lib/flow-engine/graph";
import { NODE_TYPES } from "@/lib/flow-engine/types";

import { edge, graph, node } from "./flow-fakes";

describe("node catalogue", () => {
  it("covers every node type except the trigger exactly once", () => {
    expect(NODE_DEFS.map((d) => d.type).sort()).toEqual(
      NODE_TYPES.filter((t) => t !== "trigger").sort(),
    );
  });
  it("searches label, group, description and keywords", () => {
    expect(searchNodes("buttons").map((d) => d.type)).toEqual(
      expect.arrayContaining(["question", "quick_reply"]),
    );
    expect(searchNodes("CRM").length).toBeGreaterThan(3);
    expect(searchNodes("zzzz")).toEqual([]);
    expect(searchNodes("").length).toBe(NODE_DEFS.length);
    expect(defFor("wait")?.label).toBe("Wait");
  });
  it("every node's default config builds a graph the validator accepts", () => {
    for (const d of NODE_DEFS) {
      const g = graph([node("t", "trigger"), node("n", d.type, d.defaults)], [edge("t", "n")]);
      const r = validateGraph(g);
      // Defaults may still need setup (e.g. choose a template); they must never be structurally broken.
      expect(hasErrors(r.issues.filter((i) => i.kind !== "setup")), d.type).toBe(false);
    }
  });
  it("outputs match what the validator and engine accept", () => {
    for (const d of NODE_DEFS) {
      for (const o of outputsFor(d.type, d.defaults)) {
        const g = graph(
          [node("t", "trigger"), node("n", d.type, d.defaults), node("e", "end_flow")],
          [edge("t", "n"), edge("n", "e", o.id)],
        );
        expect(
          hasErrors(validateGraph(g).issues.filter((i) => i.kind !== "setup")),
          `${d.type}:${o.id}`,
        ).toBe(false);
      }
    }
    expect(
      outputsFor("question", { style: "buttons", options: [{ id: "a", title: "A" }] }).map(
        (o) => o.id,
      ),
    ).toEqual(["option:a", "fallback"]);
    expect(outputsFor("question", { style: "text" }).map((o) => o.id)).toEqual([
      "default",
      "fallback",
    ]);
    expect(outputsFor("end_flow", {})).toEqual([]);
  });
});
