/** In-memory implementations of the flow-engine ports for unit tests. */
import { randomUUID } from "node:crypto";

import type {
  ContactView,
  ConversationView,
  CrmPort,
  FlowActions,
  FlowDeps,
  FlowStore,
  FlowView,
  InboundMessageView,
  RunRecord,
  StepRecord,
  TemplateView,
} from "@/lib/flow-engine/deps";
import type { FlowEdge, FlowGraph, FlowNode, NodeType } from "@/lib/flow-engine/types";
import type { SendSpec } from "@/lib/inbox/send";

export const ORG = "00000000-0000-4000-8000-000000000001";
export const CONTACT = "00000000-0000-4000-8000-0000000000c1";
export const CONV = "00000000-0000-4000-8000-0000000000d1";
export const FLOW = "00000000-0000-4000-8000-0000000000f1";
export const NOW = new Date("2026-10-09T08:00:00.000Z");

export function node(id: string, type: NodeType, data: Record<string, unknown> = {}): FlowNode {
  return { id, type, position: { x: 0, y: 0 }, data };
}
export function edge(source: string, target: string, handle?: string): FlowEdge {
  return {
    id: `${source}-${handle ?? "default"}-${target}`,
    source,
    target,
    sourceHandle: handle ?? null,
  };
}
export function graph(nodes: FlowNode[], edges: FlowEdge[]): FlowGraph {
  return { nodes, edges };
}

export function fakeContact(over: Partial<ContactView> = {}): ContactView {
  return {
    id: CONTACT,
    org_id: ORG,
    first_name: "Test",
    last_name: "Patient",
    full_name: "Test Patient",
    email: null,
    gender: null,
    language: null,
    label: null,
    stop_marketing: false,
    promotions_opt_in: true,
    has_phone: true,
    custom: {},
    ...over,
  };
}

export function fakeConversation(over: Partial<ConversationView> = {}): ConversationView {
  return {
    id: CONV,
    org_id: ORG,
    channel_id: "00000000-0000-4000-8000-0000000000e1",
    contact_id: CONTACT,
    status: "open",
    bot_active: false,
    flow_run_id: null,
    last_inbound_at: new Date(NOW.getTime() - 60_000).toISOString(),
    opened_at: new Date(NOW.getTime() - 3_600_000).toISOString(),
    ad_referral: null,
    assignee_user_id: null,
    assignee_team_id: null,
    ...over,
  };
}

export class FakeStore implements FlowStore {
  runs = new Map<string, RunRecord>();
  steps: StepRecord[] = [];
  flows = new Map<string, FlowView>();
  graphs = new Map<string, FlowGraph>();
  contacts = new Map<string, ContactView>([[CONTACT, fakeContact()]]);
  conversations = new Map<string, ConversationView>([[CONV, fakeConversation()]]);
  variables: Record<string, string> = {};
  templates = new Map<string, TemplateView>();

  addFlow(g: FlowGraph, over: Partial<FlowView> = {}): FlowView {
    const f: FlowView = {
      id: FLOW,
      org_id: ORG,
      name: "Test flow",
      status: "active",
      trigger_type: "shortcut",
      trigger_config: {},
      channel_id: null,
      version: 1,
      published_graph: g,
      ...over,
    };
    this.flows.set(f.id, f);
    this.graphs.set(`${f.id}:${f.version}`, g);
    return f;
  }

  async getRun(id: string) {
    const r = this.runs.get(id);
    return r ? structuredClone(r) : null;
  }
  async updateRun(id: string, patch: Partial<RunRecord>) {
    const r = this.runs.get(id);
    if (!r) throw new Error("no run");
    Object.assign(r, structuredClone(patch));
  }
  async insertStep(step: Omit<StepRecord, "id" | "status" | "output" | "error">) {
    const existing = this.steps.find((s) => s.run_id === step.run_id && s.seq === step.seq);
    if (existing) return { step: structuredClone(existing), created: false };
    const rec: StepRecord = {
      ...step,
      id: randomUUID(),
      status: "running",
      output: null,
      error: null,
    };
    this.steps.push(rec);
    return { step: structuredClone(rec), created: true };
  }
  async updateStep(
    id: string,
    patch: {
      status: StepRecord["status"];
      output?: Record<string, unknown> | null;
      error?: string | null;
    },
  ) {
    const s = this.steps.find((x) => x.id === id)!;
    s.status = patch.status;
    if (patch.output !== undefined) s.output = structuredClone(patch.output);
    if (patch.error !== undefined) s.error = patch.error;
  }
  async finishWaitingStep(runId: string, nodeId: string, output: Record<string, unknown>) {
    const s = [...this.steps]
      .reverse()
      .find((x) => x.run_id === runId && x.node_id === nodeId && x.status === "waiting");
    if (s) {
      s.status = "ok";
      s.output = { ...(s.output ?? {}), ...output };
    }
  }
  async getGraph(flowId: string, version: number) {
    return this.graphs.get(`${flowId}:${version}`) ?? null;
  }
  async getFlow(id: string) {
    return this.flows.get(id) ?? null;
  }
  async createRun(input: Parameters<FlowStore["createRun"]>[0]) {
    if (input.conversation_id && !input.parent_run_id) {
      const live = [...this.runs.values()].find(
        (r) =>
          r.conversation_id === input.conversation_id &&
          !r.parent_run_id &&
          (r.status === "running" || r.status === "waiting"),
      );
      if (live) return null;
    }
    const run: RunRecord = {
      id: randomUUID(),
      org_id: input.org_id,
      flow_id: input.flow_id,
      flow_version: input.flow_version,
      contact_id: input.contact_id,
      conversation_id: input.conversation_id,
      enquiry_id: input.enquiry_id ?? null,
      status: "running",
      current_node_id: input.current_node_id,
      context: structuredClone(input.context),
      waiting_for: null,
      step_count: 0,
      parent_run_id: input.parent_run_id ?? null,
      error: null,
    };
    this.runs.set(run.id, run);
    return structuredClone(run);
  }
  async getContact(id: string) {
    return this.contacts.get(id) ?? null;
  }
  async getConversation(id: string) {
    return this.conversations.get(id) ?? null;
  }
  async getVariables() {
    return this.variables;
  }
  async getTemplate(_org: string, id: string) {
    return this.templates.get(id) ?? null;
  }
  async getLiveRunForConversation(conversationId: string) {
    const r = [...this.runs.values()].find(
      (x) =>
        x.conversation_id === conversationId &&
        !x.parent_run_id &&
        (x.status === "running" || x.status === "waiting"),
    );
    return r ? structuredClone(r) : null;
  }
  async setConversationBot(
    id: string,
    patch: { bot_active?: boolean; flow_run_id?: string | null },
  ) {
    const c = this.conversations.get(id);
    if (c) Object.assign(c, patch);
  }
  inbound = new Map<string, InboundMessageView>();
  firstInboundText: string | null = null;
  async listActiveFlows(orgId: string, triggerType: string) {
    return [...this.flows.values()].filter(
      (f) =>
        f.org_id === orgId &&
        f.trigger_type === triggerType &&
        f.status === "active" &&
        f.published_graph,
    );
  }
  async getInboundMessage(id: string) {
    return this.inbound.get(id) ?? null;
  }
  async getFirstInboundText() {
    return this.firstInboundText;
  }
}

export class FakeActions implements FlowActions {
  sent: Array<{ spec: SendSpec; body: string | null }> = [];
  assigned: Array<{ type: string; id?: string }> = [];
  closed = 0;
  comments: string[] = [];
  contactUpdates: Array<{ field: string; value: string }> = [];
  notifications: Array<{ target: unknown; title: string; body: string }> = [];
  httpCalls: Array<{
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  }> = [];
  httpResponse: { status: number; body: unknown } = { status: 200, body: { ok: true } };

  async send(_run: RunRecord, spec: SendSpec, body: string | null) {
    this.sent.push({ spec, body });
    return { messageId: `m${this.sent.length}` };
  }
  async assign(_run: RunRecord, target: { type: string; id?: string }) {
    this.assigned.push(target);
  }
  async closeConversation() {
    this.closed += 1;
  }
  async addComment(_run: RunRecord, body: string) {
    this.comments.push(body);
  }
  async updateContactField(_run: RunRecord, field: string, value: string) {
    this.contactUpdates.push({ field, value });
  }
  async notify(
    _run: RunRecord,
    target: { type: string; id?: string },
    title: string,
    body: string,
  ) {
    this.notifications.push({ target, title, body });
    return 1;
  }
  async http(req: { method: string; url: string; headers: Record<string, string>; body?: string }) {
    this.httpCalls.push(req);
    return this.httpResponse;
  }
}

export class FakeJobs {
  steps: string[] = [];
  resumes: Array<{ runId: string; token: string; runAt: Date }> = [];
  async enqueueStep(runId: string) {
    this.steps.push(runId);
  }
  async scheduleResume(i: { runId: string; token: string; runAt: Date }) {
    this.resumes.push({ runId: i.runId, token: i.token, runAt: i.runAt });
  }
}

export class FakeLock {
  held = new Map<string, string>();
  async claim(key: string, owner: string) {
    const cur = this.held.get(key);
    if (cur && cur !== owner) return false;
    this.held.set(key, owner);
    return true;
  }
  async release(key: string, owner: string) {
    if (this.held.get(key) === owner) this.held.delete(key);
  }
}

export type Harness = {
  deps: FlowDeps;
  store: FakeStore;
  actions: FakeActions;
  jobs: FakeJobs;
  lock: FakeLock;
  /** Drain queued step jobs until none are left (or `max` iterations). Returns the number run. */
  drain(max?: number): Promise<number>;
  clock: { now: Date };
};

export function harness(opts: { crm?: CrmPort; now?: Date } = {}): Harness {
  const store = new FakeStore();
  const actions = new FakeActions();
  const jobs = new FakeJobs();
  const lock = new FakeLock();
  const clock = { now: opts.now ?? NOW };
  let n = 0;
  const deps: FlowDeps = {
    store,
    actions,
    jobs,
    lock,
    crm: opts.crm ?? {},
    now: () => clock.now,
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    timezone: "Asia/Dubai",
  };
  const h: Harness = {
    deps,
    store,
    actions,
    jobs,
    lock,
    clock,
    async drain(max = 500) {
      const { advance } = await import("@/lib/flow-engine/run");
      let ran = 0;
      while (jobs.steps.length && ran < max) {
        const id = jobs.steps.shift()!;
        await advance(deps, id);
        ran += 1;
      }
      return ran;
    },
  };
  return h;
}
