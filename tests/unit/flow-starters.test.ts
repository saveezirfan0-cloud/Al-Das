import { describe, expect, it } from "vitest";

import { hasErrors, validateGraph } from "@/lib/flow-engine/graph";
import { STARTER_FLOWS, starterFlow } from "@/lib/flow-engine/starter-flows";
import { TRIGGER_TYPES, triggerConditionsSchema } from "@/lib/flow-engine/types";

describe("starter flows", () => {
  it("have unique keys and a known trigger", () => {
    expect(new Set(STARTER_FLOWS.map((f) => f.key)).size).toBe(STARTER_FLOWS.length);
    for (const f of STARTER_FLOWS) expect(TRIGGER_TYPES).toContain(f.trigger_type);
    expect(starterFlow("inbound_routing")?.name).toContain("office hours");
    expect(starterFlow("nope")).toBeUndefined();
  });
  it("are structurally valid (nothing malformed, no dead ends from the trigger)", () => {
    for (const f of STARTER_FLOWS) {
      const r = validateGraph(f.graph);
      expect(r.graph, f.key).not.toBeNull();
      expect(hasErrors(r.issues.filter((i) => i.kind !== "setup")), `${f.key}: ${JSON.stringify(r.issues)}`).toBe(false);
      expect(r.issues.filter((i) => i.level === "warning"), f.key).toEqual([]);
    }
  });
  it("only need setup where a clinic choice is required (template / team)", () => {
    const setupKinds = (key: string) =>
      validateGraph(starterFlow(key)!.graph)
        .issues.filter((i) => i.kind === "setup")
        .map((i) => i.message)
        .sort();
    expect(setupKinds("birthday_offer_followup")).toEqual([]);
    expect(setupKinds("recall_book_now")).toEqual([]);
    expect(setupKinds("inbound_routing")).toEqual(["Choose who to assign to", "Choose who to assign to"]);
    expect(setupKinds("post_visit_followup")).toEqual(["Choose a template", "Choose a template"]);
    expect(setupKinds("no_show_recovery")).toEqual(["Choose a template"]);
  });
  it("trigger conditions parse", () => {
    for (const f of STARTER_FLOWS) {
      if (f.trigger_config.conditions) expect(triggerConditionsSchema.safeParse(f.trigger_config.conditions).success, f.key).toBe(true);
    }
  });
});
