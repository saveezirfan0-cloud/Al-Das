import { describe, expect, it } from "vitest";

import {
  buttonReplyOf,
  configMatches,
  eventTriggerKey,
  FLOW_EVENTS,
  trimEvent,
  triggerTypesFor,
} from "@/lib/flow-engine/triggers";

describe("triggerTypesFor", () => {
  it("maps domain events to trigger types", () => {
    expect(triggerTypesFor("conversation.opened", {})).toEqual(["conversation_opened"]);
    expect(triggerTypesFor("conversation.closed", {})).toEqual(["conversation_closed"]);
    expect(triggerTypesFor("enquiry.created", {})).toEqual(["enquiry_added"]);
    expect(triggerTypesFor("enquiry.stage_changed", {})).toEqual(["enquiry_stage_updated"]);
    expect(triggerTypesFor("enquiry.status_changed", {})).toEqual(["enquiry_status_updated"]);
    expect(triggerTypesFor("appointment.created", {})).toEqual(["appointment_created"]);
    expect(triggerTypesFor("appointment.updated", {})).toEqual(["appointment_updated"]);
    expect(triggerTypesFor("appointment.status_changed", {})).toEqual(["appointment_updated"]);
  });

  it("only treats message.received as a trigger when it is a button / list reply", () => {
    expect(triggerTypesFor("message.received", { kind: "text" })).toEqual([]);
    expect(triggerTypesFor("message.received", { kind: "button", interactive: null })).toEqual([
      "template_button_reply",
    ]);
    expect(
      triggerTypesFor("message.received", {
        interactive: { type: "button_reply", id: "confirm", title: "Confirm" },
      }),
    ).toEqual(["template_button_reply"]);
  });

  it("ignores events flows do not care about", () => {
    expect(triggerTypesFor("message.sent", {})).toEqual([]);
    expect(FLOW_EVENTS.has("message.sent")).toBe(false);
    expect(FLOW_EVENTS.has("message.received")).toBe(true);
  });
});

describe("configMatches", () => {
  it("number and pipeline filters", () => {
    expect(configMatches({}, "c1", {})).toBe(true);
    expect(configMatches({ channel_id: "c1" }, "c1", {})).toBe(true);
    expect(configMatches({ channel_id: "c2" }, "c1", {})).toBe(false);
    expect(configMatches({ channel_id: "c1" }, null, {})).toBe(false);
    expect(configMatches({ pipeline_id: "p1" }, null, { pipeline_id: "p1" })).toBe(true);
    expect(configMatches({ pipeline_id: "p1" }, null, { pipeline_id: "p2" })).toBe(false);
  });

  it("button ids match by id or case-insensitive title", () => {
    const p = { interactive: { id: "btn_confirm", title: "Confirm" } };
    expect(configMatches({ button_ids: ["btn_confirm"] }, null, p)).toBe(true);
    expect(configMatches({ button_ids: ["confirm"] }, null, p)).toBe(true);
    expect(configMatches({ button_ids: ["cancel"] }, null, p)).toBe(false);
    expect(configMatches({ button_ids: ["x"] }, null, { kind: "text" })).toBe(false);
  });
});

describe("eventTriggerKey / trimEvent / buttonReplyOf", () => {
  it("is stable for the same event and differs for different ones", () => {
    const a = eventTriggerKey(
      "enquiry.stage_changed",
      { enquiry_id: "e1", to_stage_id: "s1" },
      "2026-10-12T08:00:00Z",
    );
    expect(a).toBe(
      eventTriggerKey(
        "enquiry.stage_changed",
        { enquiry_id: "e1", to_stage_id: "s1" },
        "2026-10-12T08:00:00Z",
      ),
    );
    expect(a).not.toBe(
      eventTriggerKey(
        "enquiry.stage_changed",
        { enquiry_id: "e1", to_stage_id: "s2" },
        "2026-10-12T08:00:00Z",
      ),
    );
    expect(eventTriggerKey("conversation.opened", { conversation_id: "c1" }, "t")).toContain("c1");
  });

  it("trims long strings, deep objects and long arrays", () => {
    const out = trimEvent({
      a: "x".repeat(900),
      b: { c: { d: { e: { f: { g: 1 } } } } },
      list: Array.from({ length: 50 }, (_, i) => i),
    });
    expect((out.a as string).length).toBe(500);
    expect(JSON.stringify(out.b)).toBe('{"c":{"d":{"e":{"f":null}}}}');
    expect((out.list as unknown[]).length).toBe(20);
  });

  it("buttonReplyOf", () => {
    expect(buttonReplyOf({ interactive: { id: "a", title: "A" } })).toEqual({
      id: "a",
      title: "A",
    });
    expect(buttonReplyOf({ kind: "text" })).toBeNull();
  });
});
