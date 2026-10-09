import { describe, expect, it } from "vitest";

import { EVENT_TRIGGERS, factsFromReferral, handleTriggerEvent, isFlowEvent } from "@/lib/flow-engine/triggers";

import { CONTACT, CONV, FLOW, ORG, edge, fakeConversation, graph, harness, node, type Harness } from "./flow-fakes";

const g = graph([node("t", "trigger"), node("m", "add_comment", { text: "hi" })], [edge("t", "m")]);
const OTHER_FLOW = "00000000-0000-4000-8000-0000000000f9";

function addFlow(h: Harness, over: Parameters<Harness["store"]["addFlow"]>[1] = {}, id = FLOW) {
  const f = h.store.addFlow(g, { id, ...over });
  h.store.flows.set(id, f);
  h.store.graphs.set(`${id}:${f.version}`, g);
  return f;
}

describe("trigger mapping", () => {
  it("maps domain events to trigger types", () => {
    expect(EVENT_TRIGGERS["conversation.opened"]).toBe("conversation_opened");
    expect(EVENT_TRIGGERS["enquiry.stage_changed"]).toBe("enquiry_stage_updated");
    expect(isFlowEvent("message.received")).toBe(true);
    expect(isFlowEvent("message.sent")).toBe(false);
    expect(isFlowEvent("contact.created")).toBe(false);
  });
  it("derives Source / Keyword / Ad facts from a CTWA referral", () => {
    expect(factsFromReferral({ source_url: "https://fb.me/x", source_id: "123" }, "hi")).toEqual({ source: "https://fb.me/x", keyword: "hi", ad: "123" });
    expect(factsFromReferral(null, "hello")).toEqual({ source: "direct", keyword: "hello", ad: null });
  });
});

describe("conversation triggers", () => {
  it("starts the matching flow and records the trigger facts", async () => {
    const h = harness();
    addFlow(h, { trigger_type: "conversation_opened", trigger_config: { conditions: { logic: "and", conditions: [{ category: "keyword", op: "contains", value: "check" }] } } });
    h.store.firstInboundText = "I want a Check Up";
    const out = await handleTriggerEvent(h.deps, { orgId: ORG, name: "conversation.opened", payload: { conversation_id: CONV, contact_id: CONTACT } });
    expect(out.started).toHaveLength(1);
    const run = h.store.runs.get(out.started[0]!)!;
    expect(run.context.trigger).toMatchObject({ event: "conversation.opened", facts: { keyword: "I want a Check Up" } });
  });
  it("skips flows whose conditions do not match", async () => {
    const h = harness();
    addFlow(h, { trigger_type: "conversation_opened", trigger_config: { conditions: { logic: "and", conditions: [{ category: "keyword", op: "equals", value: "vaccine" }] } } });
    h.store.firstInboundText = "hello";
    const out = await handleTriggerEvent(h.deps, { orgId: ORG, name: "conversation.opened", payload: { conversation_id: CONV } });
    expect(out.started).toEqual([]);
    expect(out.skipped).toEqual([FLOW]);
  });
  it("malformed conditions never match (fail closed)", async () => {
    const h = harness();
    addFlow(h, { trigger_type: "conversation_opened", trigger_config: { conditions: { logic: "and", conditions: [{ category: "bogus" }] } } });
    const out = await handleTriggerEvent(h.deps, { orgId: ORG, name: "conversation.opened", payload: { conversation_id: CONV } });
    expect(out.started).toEqual([]);
  });
  it("respects the flow's channel and ignores other orgs / inactive flows", async () => {
    const h = harness();
    addFlow(h, { trigger_type: "conversation_opened", channel_id: "00000000-0000-4000-8000-0000000000ee" });
    addFlow(h, { trigger_type: "conversation_opened", status: "paused" }, OTHER_FLOW);
    const out = await handleTriggerEvent(h.deps, { orgId: ORG, name: "conversation.opened", payload: { conversation_id: CONV } });
    expect(out.started).toEqual([]);
    const other = await handleTriggerEvent(h.deps, { orgId: "00000000-0000-4000-8000-0000000000aa", name: "conversation.opened", payload: { conversation_id: CONV } });
    expect(other.started).toEqual([]);
  });
  it("only the first matching flow starts in a conversation", async () => {
    const h = harness();
    addFlow(h, { trigger_type: "conversation_opened" });
    addFlow(h, { trigger_type: "conversation_opened" }, OTHER_FLOW);
    const out = await handleTriggerEvent(h.deps, { orgId: ORG, name: "conversation.opened", payload: { conversation_id: CONV } });
    expect(out.started).toHaveLength(1);
  });
  it("uses the referral in the event payload for Source / Ad conditions", async () => {
    const h = harness();
    addFlow(h, { trigger_type: "conversation_opened", trigger_config: { conditions: { logic: "and", conditions: [{ category: "ad", op: "equals", value: "777" }] } } });
    const out = await handleTriggerEvent(h.deps, {
      orgId: ORG,
      name: "conversation.opened",
      payload: { conversation_id: CONV, ad_referral: { source_id: "777" } },
    });
    expect(out.started).toHaveLength(1);
  });
});

describe("message.received", () => {
  const MSG = "00000000-0000-4000-8000-0000000000c9";

  it("answers a waiting question instead of starting anything", async () => {
    const h = harness();
    h.store.addFlow(
      graph(
        [node("t", "trigger"), node("q", "question", { text: "Book?", style: "buttons", options: [{ id: "y", title: "Yes" }], variable: "a" }), node("c", "add_comment", { text: "got {vars.a}" })],
        [edge("t", "q"), edge("q", "c", "option:y")],
      ),
    );
    // start + run to the wait
    const { startRun } = await import("@/lib/flow-engine/run");
    await startRun(h.deps, { flowId: FLOW, contactId: CONTACT, conversationId: CONV });
    await h.drain();
    h.store.inbound.set(MSG, { id: MSG, conversation_id: CONV, contact_id: CONTACT, kind: "interactive", body: "Yes", reply_id: "y", template_id: null });
    const out = await handleTriggerEvent(h.deps, { orgId: ORG, name: "message.received", payload: { message_id: MSG, conversation_id: CONV } });
    expect(out.resumed).toBe(true);
    await h.drain();
    expect(h.actions.comments).toEqual(["got Yes"]);
  });

  it("ignores plain inbound text when no run is live", async () => {
    const h = harness();
    addFlow(h, { trigger_type: "template_button" });
    h.store.inbound.set(MSG, { id: MSG, conversation_id: CONV, contact_id: CONTACT, kind: "text", body: "hello", reply_id: null, template_id: null });
    const out = await handleTriggerEvent(h.deps, { orgId: ORG, name: "message.received", payload: { message_id: MSG } });
    expect(out).toEqual({ started: [], resumed: false, skipped: [] });
  });

  it("template quick-reply taps start template_button flows, filtered by template and button text", async () => {
    const h = harness();
    const TPL = "00000000-0000-4000-8000-0000000000a1";
    addFlow(h, { trigger_type: "template_button", trigger_config: { template_id: TPL, button_text: "Book now" } });
    addFlow(h, { trigger_type: "template_button", trigger_config: { button_text: "Stop" } }, OTHER_FLOW);
    h.store.inbound.set(MSG, { id: MSG, conversation_id: CONV, contact_id: CONTACT, kind: "button", body: "Book now", reply_id: "book", template_id: TPL });
    const out = await handleTriggerEvent(h.deps, { orgId: ORG, name: "message.received", payload: { message_id: MSG, conversation_id: CONV } });
    expect(out.started).toHaveLength(1);
    expect(h.store.runs.get(out.started[0]!)!.flow_id).toBe(FLOW);
    expect(h.store.runs.get(out.started[0]!)!.context.trigger).toMatchObject({ button_text: "Book now", template_id: TPL });
  });

  it("does not start a second flow while a bot run is live", async () => {
    const h = harness();
    addFlow(h, { trigger_type: "template_button" });
    h.store.conversations.set(CONV, fakeConversation());
    const { startRun } = await import("@/lib/flow-engine/run");
    h.store.addFlow(graph([node("t", "trigger"), node("w", "wait", { amount: 1, unit: "days" })], [edge("t", "w")]), { id: OTHER_FLOW, trigger_type: "shortcut" });
    await startRun(h.deps, { flowId: OTHER_FLOW, contactId: CONTACT, conversationId: CONV });
    await h.drain();
    h.store.inbound.set(MSG, { id: MSG, conversation_id: CONV, contact_id: CONTACT, kind: "button", body: "Book now", reply_id: "b", template_id: null });
    const out = await handleTriggerEvent(h.deps, { orgId: ORG, name: "message.received", payload: { message_id: MSG, conversation_id: CONV } });
    expect(out.started).toEqual([]);
  });
});

describe("other events", () => {
  it("starts enquiry / appointment flows without a conversation and keeps the payload as trigger data", async () => {
    const h = harness();
    addFlow(h, { trigger_type: "appointment_created" });
    const out = await handleTriggerEvent(h.deps, { orgId: ORG, name: "appointment.created", payload: { contact_id: CONTACT, appointment: { starts_at: "2026-10-12T09:00:00Z" } } });
    expect(out.started).toHaveLength(1);
    const run = h.store.runs.get(out.started[0]!)!;
    expect(run.conversation_id).toBeNull();
    expect(run.contact_id).toBe(CONTACT);
    expect(run.context.trigger.appointment).toEqual({ starts_at: "2026-10-12T09:00:00Z" });
  });
  it("unknown events do nothing", async () => {
    const h = harness();
    const out = await handleTriggerEvent(h.deps, { orgId: ORG, name: "contact.created", payload: {} });
    expect(out.started).toEqual([]);
  });
});
