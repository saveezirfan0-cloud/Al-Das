import { describe, expect, it } from "vitest";

import {
  conditionsMatch,
  firstMatchingRule,
  type AssignmentRule,
} from "@/lib/enquiries/assignment";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const T1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const rule = (over: Partial<AssignmentRule> & Pick<AssignmentRule, "id">): AssignmentRule => ({
  name: over.id,
  sort: 0,
  enabled: true,
  conditions: {},
  action: { type: "user", user_id: U1 },
  ...over,
});

describe("conditionsMatch", () => {
  it("matches an empty condition set", () => {
    expect(conditionsMatch({}, { pipeline_id: P1 })).toBe(true);
  });

  it("ANDs across keys and ORs within a list", () => {
    const c = { pipeline_ids: [P1, P2], sources: ["whatsapp"] };
    expect(conditionsMatch(c, { pipeline_id: P2, source: "WhatsApp" })).toBe(true);
    expect(conditionsMatch(c, { pipeline_id: P2, source: "Phone call" })).toBe(false);
    expect(conditionsMatch(c, { pipeline_id: "x", source: "whatsapp" })).toBe(false);
  });

  it("fails closed when the enquiry lacks the fact a condition asks about", () => {
    expect(conditionsMatch({ sources: ["Walk-in"] }, { pipeline_id: P1, source: null })).toBe(false);
    expect(conditionsMatch({ location_ids: [P1] }, { pipeline_id: P1 })).toBe(false);
  });
});

describe("firstMatchingRule", () => {
  const facts = { pipeline_id: P1, source: "Website" };

  it("returns the lowest-sort enabled match", () => {
    const rules = [
      rule({ id: "b", sort: 2, action: { type: "user", user_id: U2 } }),
      rule({ id: "a", sort: 1, conditions: { sources: ["Website"] } }),
    ];
    expect(firstMatchingRule(rules, facts)?.id).toBe("a");
  });

  it("skips disabled rules and rules that do not match", () => {
    const rules = [
      rule({ id: "off", sort: 0, enabled: false }),
      rule({ id: "no", sort: 1, conditions: { pipeline_ids: [P2] } }),
      rule({ id: "yes", sort: 2, action: { type: "team_round_robin", team_id: T1 } }),
    ];
    const m = firstMatchingRule(rules, facts);
    expect(m?.id).toBe("yes");
    expect(m?.action).toEqual({ type: "team_round_robin", team_id: T1 });
  });

  it("ignores rules with invalid conditions or actions instead of throwing", () => {
    const rules = [
      rule({ id: "bad-cond", sort: 0, conditions: { pipeline_ids: ["not-a-uuid"] } }),
      rule({ id: "bad-action", sort: 1, action: { type: "user" } }),
      rule({ id: "unknown-key", sort: 2, conditions: { colour: ["red"] } }),
    ];
    expect(firstMatchingRule(rules, facts)).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(firstMatchingRule([], facts)).toBeNull();
  });
});
