import type { FlowPorts } from "@/lib/flow-engine/ports";

export type Call = { fn: string; args: unknown[] };

/** Records every effect; individual ports can be overridden per test. */
export function fakePorts(
  over: Partial<FlowPorts> & { calls?: Call[] } = {},
): FlowPorts & { calls: Call[] } {
  const calls: Call[] = over.calls ?? [];
  const rec =
    <T>(fn: string, ret: T) =>
    async (...args: unknown[]) => {
      calls.push({ fn, args });
      return ret;
    };
  const base: FlowPorts = {
    now: () => new Date("2026-10-12T08:00:00Z"), // Monday 12:00 in Dubai
    timezone: "Asia/Dubai",
    hasConversation: true,
    sendText: rec("sendText", undefined) as FlowPorts["sendText"],
    sendButtons: rec("sendButtons", undefined) as FlowPorts["sendButtons"],
    sendList: rec("sendList", undefined) as FlowPorts["sendList"],
    sendTemplate: rec("sendTemplate", undefined) as FlowPorts["sendTemplate"],
    assign: rec("assign", undefined) as FlowPorts["assign"],
    closeConversation: rec("closeConversation", undefined) as FlowPorts["closeConversation"],
    addComment: rec("addComment", undefined) as FlowPorts["addComment"],
    updateContact: rec("updateContact", undefined) as FlowPorts["updateContact"],
    upsertEnquiry: rec("upsertEnquiry", { id: "enq-1" }) as FlowPorts["upsertEnquiry"],
    createTask: rec("createTask", { id: "task-1" }) as FlowPorts["createTask"],
    portalRecord: rec("portalRecord", { id: "rec-1" }) as FlowPorts["portalRecord"],
    appointment: rec("appointment", { id: "apt-1" }) as FlowPorts["appointment"],
    httpRequest: rec("httpRequest", {
      status: 200,
      text: '{"ok":true,"n":3}',
    }) as FlowPorts["httpRequest"],
    notify: rec("notify", 2) as FlowPorts["notify"],
  };
  return Object.assign({ ...base, ...over }, { calls });
}
