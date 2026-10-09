import { describe, expect, it } from "vitest";

import { and, cond } from "@/lib/filters/ast";
import { executeNode, type NodeResult, type StepInput } from "@/lib/flow-engine/executors";
import { FlowNodeError } from "@/lib/flow-engine/ports";
import { NODE_TYPES, type FlowNode, type NodeType } from "@/lib/flow-engine/types";

import { fakePorts } from "./fake-ports";

const scope = {
  contact: { first_name: "Sara" },
  appointment: { starts_at: "2026-10-14T06:30:00Z" },
  vars: { who: "Sara", when: "2026-10-20T06:00:00Z", appt: "A-77" },
  steps: { api: { response: { id: "X9" } } },
};
const node = (type: NodeType, data: Record<string, unknown> = {}): FlowNode => ({
  id: "n1",
  type,
  position: { x: 0, y: 0 },
  data,
});
const run = (
  n: FlowNode,
  over: Parameters<typeof fakePorts>[0] = {},
  input: StepInput = { type: "start" },
) => {
  const ports = fakePorts(over);
  return { ports, promise: executeNode(n, { nodeId: n.id, scope, ports, input }) };
};
const next = (r: NodeResult) => {
  expect(r.kind).toBe("next");
  return r as Extract<NodeResult, { kind: "next" }>;
};
const opts = [
  { id: "yes", title: "Yes" },
  { id: "no", title: "No" },
];
const reply = (
  text: string | null,
  interactiveId: string | null = null,
  type = "text",
): StepInput => ({ type: "reply", reply: { type, text, interactiveId } });

describe("every node type has an executor test below", () => {
  it("covers the catalogue", () => {
    expect(NODE_TYPES.length).toBe(20);
  });
});

describe("trigger / end_flow / run_flow", () => {
  it("trigger passes through", async () =>
    expect(next(await run(node("trigger")).promise).handle).toBe("default"));
  it("end_flow ends", async () => expect((await run(node("end_flow")).promise).kind).toBe("end"));
  it("run_flow transfers", async () =>
    expect(
      await run(node("run_flow", { flowId: "3b9d5c1e-6b6e-4a52-8b27-6d6b0d7c3a11" })).promise,
    ).toEqual({ kind: "transfer", flowId: "3b9d5c1e-6b6e-4a52-8b27-6d6b0d7c3a11" }));
});

describe("message", () => {
  it("interpolates and sends", async () => {
    const { ports, promise } = run(node("message", { text: "Hello {contact.first_name}" }));
    next(await promise);
    expect(ports.calls).toEqual([{ fn: "sendText", args: ["Hello Sara"] }]);
  });
  it("fails without a conversation or with an empty result", async () => {
    await expect(
      run(node("message", { text: "x" }), { hasConversation: false }).promise,
    ).rejects.toThrow(FlowNodeError);
    await expect(run(node("message", { text: "{vars.nothing}" })).promise).rejects.toThrow(/empty/);
  });
  it("rejects invalid configuration", async () => {
    await expect(run(node("message", { text: "" })).promise).rejects.toThrow(/not configured/);
  });
});

describe("question", () => {
  const q = (kind: string, extra: Record<string, unknown> = {}) =>
    node("question", {
      text: "Pick",
      kind,
      options: kind === "text" ? [] : opts,
      variable: "choice",
      ...extra,
    });
  it("asks with buttons, then waits (with timeout)", async () => {
    const { ports, promise } = run(q("buttons", { timeoutMinutes: 30 }));
    expect(await promise).toMatchObject({ kind: "wait_reply", timeoutMinutes: 30 });
    expect(ports.calls[0]).toMatchObject({ fn: "sendButtons" });
  });
  it("asks with a list and with free text", async () => {
    expect(
      await (async () => {
        const r = run(q("list"));
        await r.promise;
        return r.ports.calls[0].fn;
      })(),
    ).toBe("sendList");
    const t = run(q("text"));
    await t.promise;
    expect(t.ports.calls[0].fn).toBe("sendText");
  });
  it("buttons: matches by interactive id or by title and saves the variable", async () => {
    const byId = next(await run(q("buttons"), {}, reply(null, "yes", "interactive")).promise);
    expect(byId).toMatchObject({ handle: "option:yes", vars: { choice: "Yes", choice_id: "yes" } });
    const byText = next(await run(q("buttons"), {}, reply("  no ")).promise);
    expect(byText.handle).toBe("option:no");
  });
  it("buttons: an unknown answer takes the fallback", async () => {
    expect(next(await run(q("buttons"), {}, reply("maybe")).promise)).toMatchObject({
      handle: "fallback",
      detail: { reason: "no_match" },
    });
  });
  it("timeout takes the fallback", async () => {
    expect(next(await run(q("buttons"), {}, { type: "timeout" }).promise).handle).toBe("fallback");
  });
  it("free text saves any text, but not other message types", async () => {
    expect(next(await run(q("text"), {}, reply("my answer")).promise)).toMatchObject({
      handle: "default",
      vars: { choice: "my answer" },
    });
    expect(next(await run(q("text"), {}, reply(null, null, "image")).promise).handle).toBe(
      "fallback",
    );
  });
  it("does not send when resumed (only on start)", async () => {
    const { ports, promise } = run(q("buttons"), {}, reply("yes"));
    await promise;
    expect(ports.calls).toEqual([]);
  });
});

describe("quick_reply", () => {
  const qr = node("quick_reply", { text: "Confirm?", options: opts });
  it("sends buttons and waits", async () => {
    const { ports, promise } = run(qr);
    expect((await promise).kind).toBe("wait_reply");
    expect(ports.calls[0].fn).toBe("sendButtons");
  });
  it("routes by option, falls back otherwise", async () => {
    expect(next(await run(qr, {}, reply(null, "no", "interactive")).promise).handle).toBe(
      "option:no",
    );
    expect(next(await run(qr, {}, reply("???")).promise).handle).toBe("fallback");
    expect(next(await run(qr, {}, { type: "timeout" }).promise).handle).toBe("fallback");
  });
});

describe("template", () => {
  it("interpolates values and sends the template", async () => {
    const id = "3b9d5c1e-6b6e-4a52-8b27-6d6b0d7c3a11";
    const { ports, promise } = run(
      node("template", {
        templateId: id,
        values: {
          "body.1": "{contact.first_name}",
          "body.2": '{appointment.starts_at|date:"DD MMM"}',
        },
      }),
    );
    next(await promise);
    expect(ports.calls[0]).toEqual({
      fn: "sendTemplate",
      args: [id, { "body.1": "Sara", "body.2": "14 Oct" }],
    });
  });
  it("needs a conversation", async () => {
    await expect(
      run(node("template", { templateId: "3b9d5c1e-6b6e-4a52-8b27-6d6b0d7c3a11" }), {
        hasConversation: false,
      }).promise,
    ).rejects.toThrow(FlowNodeError);
  });
});

describe("branch", () => {
  const b = (value: string) =>
    node("branch", { conditions: { include: and(cond("contact.first_name", "eq", value)) } });
  it("true / false", async () => {
    expect(next(await run(b("Sara")).promise).handle).toBe("true");
    expect(next(await run(b("Omar")).promise).handle).toBe("false");
  });
});

describe("wait", () => {
  it("waits until now + duration, then continues when the timer fires", async () => {
    const n = node("wait", { amount: 2, unit: "hours" });
    const r = await run(n).promise;
    expect(r).toMatchObject({ kind: "wait_time" });
    expect((r as { until: Date }).until.toISOString()).toBe("2026-10-12T10:00:00.000Z");
    expect(next(await run(n, {}, { type: "time" }).promise).handle).toBe("default");
  });
  it("supports days and seconds", async () => {
    const d = (await run(node("wait", { amount: 1, unit: "days" })).promise) as { until: Date };
    expect(d.until.toISOString()).toBe("2026-10-13T08:00:00.000Z");
    const s = (await run(node("wait", { amount: 30, unit: "seconds" })).promise) as { until: Date };
    expect(s.until.toISOString()).toBe("2026-10-12T08:00:30.000Z");
  });
  it("rejects waits over 30 days", async () => {
    await expect(run(node("wait", { amount: 31, unit: "days" })).promise).rejects.toThrow();
  });
});

describe("office_hours", () => {
  const days = { mon: [{ from: "09:00", to: "18:00" }] };
  it("inside at Monday noon Dubai, outside at night", async () => {
    expect(next(await run(node("office_hours", { days })).promise).handle).toBe("inside");
    const night = fakePorts({ now: () => new Date("2026-10-12T20:00:00Z") });
    expect(
      next(
        await executeNode(node("office_hours", { days }), {
          nodeId: "n1",
          scope,
          ports: night,
          input: { type: "start" },
        }),
      ).handle,
    ).toBe("outside");
  });
  it("uses its own time zone when given", async () => {
    // 08:00 UTC is 08:00 in UTC: before opening
    expect(next(await run(node("office_hours", { days, timezone: "UTC" })).promise).handle).toBe(
      "outside",
    );
  });
});

describe("conversation nodes", () => {
  it("assign_to a user or a team", async () => {
    const u = run(node("assign_to", { userId: "3b9d5c1e-6b6e-4a52-8b27-6d6b0d7c3a11" }));
    next(await u.promise);
    expect(u.ports.calls[0]).toEqual({
      fn: "assign",
      args: [{ userId: "3b9d5c1e-6b6e-4a52-8b27-6d6b0d7c3a11", teamId: undefined }],
    });
    await expect(run(node("assign_to", {})).promise).rejects.toThrow(/not configured/);
    await expect(
      run(node("assign_to", { teamId: "3b9d5c1e-6b6e-4a52-8b27-6d6b0d7c3a11" }), {
        hasConversation: false,
      }).promise,
    ).rejects.toThrow(FlowNodeError);
  });
  it("close_conversation", async () => {
    const r = run(node("close_conversation"));
    next(await r.promise);
    expect(r.ports.calls[0].fn).toBe("closeConversation");
    await expect(
      run(node("close_conversation"), { hasConversation: false }).promise,
    ).rejects.toThrow(FlowNodeError);
  });
  it("add_comment interpolates", async () => {
    const r = run(node("add_comment", { text: "Bot note for {contact.first_name}" }));
    next(await r.promise);
    expect(r.ports.calls[0]).toEqual({ fn: "addComment", args: ["Bot note for Sara"] });
  });
});

describe("CRM nodes", () => {
  it("update_contact interpolates every field", async () => {
    const r = run(
      node("update_contact", {
        fields: [
          { field: "first_name", value: "{vars.who}" },
          { field: "language", value: "ar" },
        ],
      }),
    );
    next(await r.promise);
    expect(r.ports.calls[0]).toEqual({
      fn: "updateContact",
      args: [{ first_name: "Sara", language: "ar" }],
    });
    await expect(
      run(node("update_contact", { fields: [{ field: "dob", value: "x" }] })).promise,
    ).rejects.toThrow(/not configured/);
  });
  it("enquiry create exposes its id to later steps", async () => {
    const res = next(
      await run(node("enquiry", { action: "create", subject: "For {contact.first_name}" })).promise,
    );
    expect(res.output).toEqual({ id: "enq-1" });
    expect(res.context).toEqual({ enquiry_id: "enq-1" });
  });
  it("add_task computes the due time from the clock", async () => {
    const r = run(node("add_task", { subject: "Call {contact.first_name}", dueInHours: 4 }));
    next(await r.promise);
    const [input] = r.ports.calls[0].args as [{ subject: string; dueAt: Date }];
    expect(input.subject).toBe("Call Sara");
    expect(input.dueAt.toISOString()).toBe("2026-10-12T12:00:00.000Z");
  });
  it("portal_record needs a record id to update", async () => {
    await expect(
      run(node("portal_record", { objectKey: "ref_items", action: "update", values: {} })).promise,
    ).rejects.toThrow(/record id/);
    const r = run(
      node("portal_record", {
        objectKey: "ref_items",
        action: "update",
        recordId: "{vars.appt}",
        values: { name: "{vars.who}" },
      }),
    );
    next(await r.promise);
    expect(r.ports.calls[0].args[0]).toEqual({
      objectKey: "ref_items",
      action: "update",
      recordId: "A-77",
      values: { name: "Sara" },
    });
  });
  it("appointment set_status and create", async () => {
    const s = run(
      node("appointment", {
        action: "set_status",
        status: "confirmed",
        appointmentId: "{vars.appt}",
      }),
    );
    next(await s.promise);
    expect(s.ports.calls[0].args[0]).toEqual({
      action: "set_status",
      status: "confirmed",
      appointmentId: "A-77",
    });
    const c = run(
      node("appointment", { action: "create", startsAt: "{vars.when}", durationMinutes: 30 }),
    );
    const res = next(await c.promise);
    expect(res.context).toEqual({ appointment_id: "apt-1" });
    await expect(
      run(node("appointment", { action: "create", startsAt: "soon" })).promise,
    ).rejects.toThrow(/start time/);
    await expect(run(node("appointment", { action: "set_status" })).promise).rejects.toThrow(
      /Choose/,
    );
  });
});

describe("api_action", () => {
  const api = (extra: Record<string, unknown> = {}) =>
    node("api_action", {
      method: "POST",
      url: "https://example.org/x/{vars.who}",
      body: '{"n":"{contact.first_name}"}',
      headers: { "X-K": "{vars.appt}" },
      ...extra,
    });
  it("interpolates the request, keeps the parsed response and saves the text", async () => {
    const r = run(api({ saveAs: "raw" }));
    const res = next(await r.promise);
    expect(r.ports.calls[0].args[0]).toEqual({
      method: "POST",
      url: "https://example.org/x/Sara",
      headers: { "X-K": "A-77" },
      body: '{"n":"Sara"}',
    });
    expect(res.handle).toBe("default");
    expect(res.output).toEqual({ status: 200, response: { ok: true, n: 3 } });
    expect(res.vars).toEqual({ raw: '{"ok":true,"n":3}' });
  });
  it("non-2xx and transport errors take the fallback exit and carry a failure reason", async () => {
    const bad = next(
      await run(api(), { httpRequest: async () => ({ status: 500, text: "boom" }) }).promise,
    );
    expect(bad).toMatchObject({ handle: "fallback", failed: "The API answered 500." });
    const thrown = next(
      await run(api(), {
        httpRequest: async () => {
          throw new FlowNodeError("Blocked address");
        },
      }).promise,
    );
    expect(thrown).toMatchObject({ handle: "fallback", failed: "Blocked address" });
    const unknown = next(
      await run(api(), {
        httpRequest: async () => {
          throw new Error("socket hang up");
        },
      }).promise,
    );
    expect(unknown.failed).toBe("The request could not be completed.");
  });
});

describe("send_notification", () => {
  it("notifies a user or everyone with a permission", async () => {
    const r = run(
      node("send_notification", {
        permission: "tasks.manage",
        title: "New lead {contact.first_name}",
      }),
    );
    expect(next(await r.promise).detail).toEqual({ notified: 2 });
    expect(r.ports.calls[0].args[0]).toEqual({
      userId: undefined,
      permission: "tasks.manage",
      title: "New lead Sara",
      body: undefined,
    });
    await expect(run(node("send_notification", { title: "x" })).promise).rejects.toThrow(
      /not configured/,
    );
  });
});
