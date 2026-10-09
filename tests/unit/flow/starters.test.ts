import { describe, expect, it } from "vitest";

import { validateGraph } from "@/lib/flow-engine/graph";
import { FLOW_STARTERS, starterByKey } from "@/lib/flow-engine/starters";
import { TRIGGER_TYPES } from "@/lib/flow-engine/types";

describe("starter flows", () => {
  it("have unique keys and a known trigger", () => {
    expect(new Set(FLOW_STARTERS.map((s) => s.key)).size).toBe(FLOW_STARTERS.length);
    for (const s of FLOW_STARTERS) expect(TRIGGER_TYPES).toContain(s.trigger_type);
    expect(starterByKey("welcome_office_hours")?.name).toBe("Welcome and office hours");
    expect(starterByKey("nope")).toBeUndefined();
  });

  for (const s of FLOW_STARTERS) {
    describe(s.key, () => {
      const v = validateGraph(s.graph, {
        triggerType: s.trigger_type,
        triggerConfig: s.trigger_config,
        knownVariables: [],
      });

      it("parses and is wired from the trigger", () => {
        expect(v.graph).not.toBeNull();
        expect(
          v.issues.some((i) =>
            /malformed|no trigger|Connect the trigger|not connected/.test(i.message),
          ),
        ).toBe(false);
      });

      it("cannot be published until the person fills in the choices it lists", () => {
        // Every error is a placeholder the person must choose; nothing else is wrong with the flow.
        expect(v.errors).toBeGreaterThan(0);
        expect(s.needs.length).toBeGreaterThan(0);
        for (const i of v.issues.filter((x) => x.severity === "error")) {
          expect(i.message, i.message).toMatch(
            /template|Choose|person or a team|who to notify|uuid|Invalid|Too small|expected/i,
          );
        }
      });

      it("uses no clinical advice words and no real contact details", () => {
        const text = JSON.stringify(s.graph).toLowerCase();
        for (const w of ["diagnos", "dose", "dosage", "mg ", "prescrib", "@", "+971"])
          expect(text, w).not.toContain(w);
      });
    });
  }
});
