import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AI_NODE_TYPES, AI_TRIGGER_TYPES, STRIPPED_NODE_TYPES } from "@/lib/ai/flow-copilot/policy";
import { PERMISSION_KEYS, SYSTEM_ROLES, permissionMatches } from "@/lib/auth/permissions";
import { EXECUTORS } from "@/lib/flow-engine/executors";
import { TRIGGER_LABELS } from "@/lib/flow-engine/labels";
import { NODE_DATA_SCHEMAS } from "@/lib/flow-engine/node-schemas";
import { EVENT_TRIGGERS, handleTriggerEvent, isFlowEvent } from "@/lib/flow-engine/triggers";
import { NODE_TYPES, TRIGGER_TYPES } from "@/lib/flow-engine/types";
import { eventsFor, getEvent } from "@/lib/notify/events";
import { buildPushPayload, genericEmail } from "@/lib/notify/push-payload";

import { CONV, FLOW, ORG, edge, graph, harness, node } from "../flow-fakes";

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

describe("permissions", () => {
  const perms = (name: string) => SYSTEM_ROLES.find((r) => r.name === name)!.permissions;
  it("defines the three new keys and gives them only to Manager and Marketing (insights: Manager only)", () => {
    for (const k of ["flows.ai", "campaigns.ai", "ai.insights.view"])
      expect(PERMISSION_KEYS).toContain(k);
    expect(perms("Manager")).toEqual(
      expect.arrayContaining(["flows.ai", "campaigns.ai", "ai.insights.view"]),
    );
    expect(perms("Marketing")).toEqual(expect.arrayContaining(["flows.ai", "campaigns.ai"]));
    expect(perms("Marketing")).not.toContain("ai.insights.view");
    for (const role of [
      "Agent",
      "Receptionist",
      "Care coordinator",
      "Finance",
      "Billing",
      "Insurance",
      "CEO",
      "Medical Director",
    ])
      for (const k of ["flows.ai", "campaigns.ai", "ai.insights.view"])
        expect(
          perms(role).some((p) => permissionMatches(p, k)),
          `${role} ${k}`,
        ).toBe(false);
  });

  it("keeps the copilot permissions separate from the abilities they sit on top of", () => {
    // Holding flows.manage or campaigns.create alone never reaches the model.
    expect(permissionMatches("flows.manage", "flows.ai")).toBe(false);
    expect(permissionMatches("campaigns.create", "campaigns.ai")).toBe(false);
    expect(permissionMatches("ai.use", "flows.ai")).toBe(false);
  });
});

describe("the copilot cannot create a node type nobody has decided about", () => {
  it("puts every node type in exactly one of: allowed, stripped", () => {
    for (const t of NODE_TYPES) {
      const allowed = (AI_NODE_TYPES as readonly string[]).includes(t);
      const stripped = (STRIPPED_NODE_TYPES as readonly string[]).includes(t);
      expect(
        allowed !== stripped,
        `${t} must be in AI_NODE_TYPES or STRIPPED_NODE_TYPES (lib/ai/flow-copilot/policy.ts)`,
      ).toBe(true);
    }
  });

  it("never allows api_action, the node that can send data to a web address", () => {
    expect(AI_NODE_TYPES).not.toContain("api_action");
    expect(STRIPPED_NODE_TYPES).toContain("api_action");
  });

  it("never allows the webhook, recurring or AI-tag triggers", () => {
    for (const t of ["webhook", "recurring", "conversation_ai_tagged"])
      expect(AI_TRIGGER_TYPES).not.toContain(t);
  });

  it("has a settings schema and an executor for every node type (the validator and the dry run rely on both)", () => {
    expect(Object.keys(NODE_DATA_SCHEMAS).sort()).toEqual([...NODE_TYPES].sort());
    expect(Object.keys(EXECUTORS).sort()).toEqual([...NODE_TYPES].sort());
  });
});

describe("emergency and report notifications", () => {
  it("are catalogued; the emergency one is urgent and offered to everyone, the report only with its permission", () => {
    expect(getEvent("inbox.emergency")).toMatchObject({ urgent: true, group: "Escalation" });
    expect(getEvent("inbox.emergency")!.permission).toBeUndefined();
    expect(eventsFor((p) => p === "inbox.send").map((e) => e.key)).toContain("inbox.emergency");
    expect(eventsFor((p) => p === "inbox.send").map((e) => e.key)).not.toContain(
      "ai.insights_ready",
    );
    expect(eventsFor((p) => p === "ai.insights.view").map((e) => e.key)).toContain(
      "ai.insights_ready",
    );
  });

  it("carry a fixed generic sentence and ids only: nothing a patient said can reach push or e-mail", () => {
    const UUID = "9d2e6f0a-1b2c-4d3e-8f4a-5b6c7d8e9f01";
    const p = buildPushPayload("inbox.emergency", { conversation_id: UUID })!;
    expect(p.url).toBe(`/inbox?c=${UUID}`);
    expect(`${p.title} ${p.body}`).not.toMatch(/[0-9@+]/);
    expect(`${p.title} ${p.body}`.toLowerCase()).not.toMatch(/chest|breath|bleed|suicide|pain/);
    expect(genericEmail("inbox.emergency")!.sentence).toBe(p.body);
    expect(buildPushPayload("ai.insights_ready", {})!.url).toBe("/reports/ai-quality");
  });
});

describe("AI tags as a flow trigger", () => {
  it("is a known trigger with a label, and the event reaches the flow queue", () => {
    expect(TRIGGER_TYPES).toContain("conversation_ai_tagged");
    expect(TRIGGER_LABELS.conversation_ai_tagged).toMatch(/clinical sign-off/);
    expect(EVENT_TRIGGERS["conversation.ai_tagged"]).toBe("conversation_ai_tagged");
    expect(isFlowEvent("conversation.ai_tagged")).toBe(true);
  });

  it("starts a flow only for a tag the flow names", async () => {
    const h = harness();
    h.store.addFlow(graph([node("t", "trigger"), node("e", "end_flow")], [edge("t", "e")]), {
      trigger_type: "conversation_ai_tagged",
      trigger_config: { tags: ["booking"] },
    });
    const none = await handleTriggerEvent(h.deps, {
      orgId: ORG,
      name: "conversation.ai_tagged",
      payload: { conversation_id: CONV, tags: ["price"] },
    });
    expect(none.started).toEqual([]);
    const hit = await handleTriggerEvent(h.deps, {
      orgId: ORG,
      name: "conversation.ai_tagged",
      payload: { conversation_id: CONV, tags: ["price", "booking"] },
    });
    expect(hit.started).toHaveLength(1);
    expect(h.store.flows.get(FLOW)).toBeTruthy();
  });

  it("does not start a flow that names no tags", async () => {
    const h = harness();
    h.store.addFlow(graph([node("t", "trigger")], []), {
      trigger_type: "conversation_ai_tagged",
      trigger_config: {},
    });
    const out = await handleTriggerEvent(h.deps, {
      orgId: ORG,
      name: "conversation.ai_tagged",
      payload: { conversation_id: CONV, tags: ["booking"] },
    });
    expect(out.started).toEqual([]);
  });
});

describe("no path publishes or activates an AI draft by itself", () => {
  const flowActions = read("app/(app)/flows/actions.ts");
  const aiActions = read("app/(app)/flows/ai-actions.ts");

  it("publishFlow and setFlowStatus refuse an unreviewed AI draft before they write anything", () => {
    const publish = flowActions.slice(
      flowActions.indexOf("export async function publishFlow"),
      flowActions.indexOf("export async function setFlowStatus"),
    );
    expect(publish.indexOf("ai_review_required")).toBeGreaterThan(-1);
    expect(publish.indexOf("ai_review_required")).toBeLessThan(publish.indexOf('"flow_versions"'));
    const status = flowActions.slice(
      flowActions.indexOf("export async function setFlowStatus"),
      flowActions.indexOf("export async function duplicateFlow"),
    );
    expect(status.indexOf("ai_review_required")).toBeLessThan(
      status.indexOf(".update({ status })"),
    );
  });

  it("a duplicate of an AI draft is still an AI draft", () => {
    expect(flowActions).toMatch(/ai_review_required: f\.ai_review_required/);
  });

  it("the AI actions create drafts only: they never set a status, a version or a published graph", () => {
    expect(aiActions).toContain('status: "draft"');
    expect(aiActions).not.toMatch(
      /published_graph|version:|status: "active"|publishFlow|setFlowStatus/,
    );
  });

  it("the dry run imports no engine adapter that can write or send", () => {
    expect(aiActions).not.toMatch(/createFlowDeps|supabase-deps|queueOutbound|enqueue\(/);
  });
});
