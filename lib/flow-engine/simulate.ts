/**
 * Dry run: replays sample inbound messages through a flow graph WITHOUT touching anything real.
 *
 * It drives the REAL engine (lib/flow-engine/run.ts and every executor) through in-memory implementations of the engine's
 * ports (store, actions, jobs, lock, CRM). There is no database client, no queue, no network and no WhatsApp client in
 * this file: a "send" is a line in the result, an API call is never made, a wait is skipped ahead on a fake clock.
 * Works on a DRAFT graph (the engine only needs the graph; nothing is published or saved).
 */
import { matchTriggerConditions } from "@/lib/flow-engine/conditions";
import { defFor } from "@/lib/flow-engine/catalog";
import type {
  ContactView,
  ConversationView,
  CrmPort,
  FlowActions,
  FlowDeps,
  FlowLock,
  FlowStore,
  FlowView,
  InboundMessageView,
  RunRecord,
  StepRecord,
  TemplateView,
} from "@/lib/flow-engine/deps";
import { advance, resumeFromReply, resumeFromTimer, startRun } from "@/lib/flow-engine/run";
import { triggerConditionsSchema, type FlowGraph, type Outcome } from "@/lib/flow-engine/types";
import type { SendSpec } from "@/lib/inbox/send";

const ORG = "00000000-0000-4000-8000-0000000051a1";
const FLOW = "00000000-0000-4000-8000-0000000051f1";
const CONTACT = "00000000-0000-4000-8000-0000000051c1";
const CONV = "00000000-0000-4000-8000-0000000051d1";
const CHANNEL = "00000000-0000-4000-8000-0000000051e1";
/** Stands in for a template / team the person has not chosen yet. */
export const SIM_PLACEHOLDER_ID = "00000000-0000-4000-8000-0000000051b1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SIM_LIMITS = { maxInbound: 10, maxMessageChars: 500, maxIterations: 600 } as const;

export type SimTemplate = { id: string; name: string; category: string; status: string };

export type SimInput = {
  graph: FlowGraph;
  triggerType: string;
  triggerConfig?: Record<string, unknown>;
  /** What the patient types, in order. The first one starts the flow for conversation triggers; the rest answer questions. */
  inbound: string[];
  /** Templates that exist (names only are shown), so a template node can run. Unknown ids fail as they would live. */
  templates?: SimTemplate[];
  contact?: { firstName: string; language: "en" | "ar" };
  startAt?: Date;
  timezone?: string;
};

export type SimStepView = {
  seq: number;
  nodeId: string;
  nodeType: string;
  label: string;
  outcome: "ok" | "waiting" | "failed";
  /** One plain sentence: what happened (or what would have happened live). */
  detail: string;
  /** The output that was followed (true / false / option:x / fallback ...), when it matters. */
  handle?: string;
  /** This node still needs a template, team or person to be chosen; the dry run used a stand-in. */
  stub?: boolean;
};

export type SimResult = {
  /** completed: reached an end. waiting: stopped waiting for a reply the samples did not cover. failed: a step failed. not_started: the trigger did not match. */
  status: "completed" | "waiting" | "failed" | "not_started" | "stopped";
  reason: string;
  steps: SimStepView[];
  /** Messages the bot would have sent, in order, text only. */
  sent: Array<{ nodeId: string; kind: string; text: string }>;
  /** Sample messages the run consumed (the first one starts the flow for conversation triggers). */
  inboundUsed: number;
  /** Sample messages the flow never reached. */
  inboundUnused: number;
  /** Answers a question did not understand (the bot kept waiting). */
  unmatchedReplies: number;
};

// ---------------------------------------------------------------------------
// In-memory ports
// ---------------------------------------------------------------------------

class SimStore implements FlowStore {
  runs = new Map<string, RunRecord>();
  steps: StepRecord[] = [];
  private n = 0;
  constructor(
    private readonly flow: FlowView,
    private readonly contact: ContactView,
    private readonly conversation: ConversationView | null,
    private readonly templates: Map<string, TemplateView>,
    /** Flows a "Run flow" node points at: not simulated, each stands in as a trigger that ends at once. */
    private readonly nested: Map<string, FlowGraph>,
  ) {}
  private id() {
    return `00000000-0000-4000-8000-${String(++this.n + 1000).padStart(12, "0")}`;
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
      id: this.id(),
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
  async getGraph(flowId: string) {
    return flowId === this.flow.id ? this.flow.published_graph : (this.nested.get(flowId) ?? null);
  }
  async getFlow(flowId: string) {
    if (flowId === this.flow.id) return this.flow;
    const g = this.nested.get(flowId);
    return g ? nestedFlow(flowId, g) : null;
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
      id: this.id(),
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
  async getContact() {
    return this.contact;
  }
  async getConversation() {
    return this.conversation;
  }
  async getVariables() {
    return {} as Record<string, string>;
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
    if (this.conversation && this.conversation.id === id) Object.assign(this.conversation, patch);
  }
  async listActiveFlows() {
    return [] as FlowView[];
  }
  async getInboundMessage(): Promise<InboundMessageView | null> {
    return null;
  }
  async getFirstInboundText() {
    return null;
  }
}

function nestedFlow(id: string, graph: FlowGraph): FlowView {
  return {
    id,
    org_id: ORG,
    name: "Nested flow (not simulated)",
    status: "active",
    trigger_type: "shortcut",
    trigger_config: {},
    channel_id: null,
    version: 1,
    published_graph: graph,
  };
}

class SimLock implements FlowLock {
  private held = new Map<string, string>();
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

type Recorded = { nodeId: string; kind: string; text: string };

class SimActions implements FlowActions {
  sent: Recorded[] = [];
  notes: Array<{ nodeId: string; text: string }> = [];
  /** What each non-message action would have done, by node. */
  effects = new Map<string, string>();
  private current = "";
  private n = 0;
  at(nodeId: string) {
    this.current = nodeId;
  }
  record(text: string) {
    this.effects.set(this.current, text);
  }
  async send(_run: RunRecord, spec: SendSpec, body: string | null) {
    const text =
      body ??
      (spec.type === "template"
        ? `[template: ${String((spec as { template_id?: string }).template_id ?? "").slice(0, 8)}]`
        : `[${spec.type}]`);
    this.sent.push({
      nodeId: this.current,
      kind: spec.type,
      text: text.slice(0, SIM_LIMITS.maxMessageChars),
    });
    return { messageId: `sim-${++this.n}` };
  }
  async assign(_run: RunRecord, target: { type: string; id?: string }) {
    this.effects.set(
      this.current,
      target.type === "team" || target.type === "user"
        ? `Would hand the conversation to a ${target.type}${target.id === SIM_PLACEHOLDER_ID ? " (not chosen yet)" : ""}`
        : `Would set the conversation to ${target.type}`,
    );
  }
  async closeConversation() {
    this.effects.set(this.current, "Would close the conversation");
  }
  async addComment(_run: RunRecord, body: string) {
    this.effects.set(this.current, `Would add an internal note: ${body.slice(0, 80)}`);
  }
  async updateContactField(_run: RunRecord, field: string) {
    this.effects.set(this.current, `Would update the contact's ${field}`);
  }
  async notify(_run: RunRecord, target: { type: string; id?: string }, title: string) {
    this.effects.set(
      this.current,
      `Would notify ${target.type} "${target.type === "role" ? target.id : "selected"}": ${title.slice(0, 60)}`,
    );
    return 1;
  }
  async http(req: { method: string; url: string }) {
    // Never called out. Only the host is kept, so the line is useful without carrying a full URL.
    let host = "";
    try {
      host = new URL(req.url).hostname;
    } catch {
      host = "invalid address";
    }
    this.effects.set(this.current, `Would call ${req.method} ${host} (not made in a dry run)`);
    return { status: 200, body: {} as unknown };
  }
}

function simCrm(actions: SimActions): CrmPort {
  const stub = (label: string) => async () => {
    actions.record(`Would ${label} (not done in a dry run)`);
    return { id: "sim" };
  };
  return {
    createEnquiry: stub("create an enquiry"),
    addTask: stub("add a task"),
    upsertPortalRecord: stub("save a portal record"),
    bookAppointment: stub("book an appointment"),
  };
}

// ---------------------------------------------------------------------------
// Graph preparation and the run
// ---------------------------------------------------------------------------

/** Copies the graph, putting a stand-in where a template / team / role has not been chosen yet. Returns the stand-in node ids. */
export function prepareGraphForSim(graph: FlowGraph): {
  graph: FlowGraph;
  stubbed: Set<string>;
  nested: Map<string, FlowGraph>;
} {
  const stubbed = new Set<string>();
  const nested = new Map<string, FlowGraph>();
  const nodes = graph.nodes.map((n) => {
    const data = structuredClone(n.data) as Record<string, unknown>;
    if (
      n.type === "template" &&
      !(typeof data.template_id === "string" && UUID.test(data.template_id))
    ) {
      data.template_id = SIM_PLACEHOLDER_ID;
      stubbed.add(n.id);
    } else if (n.type === "assign_to") {
      const t = (data.target ?? {}) as { type?: string; id?: string };
      if (
        (t.type === "team" || t.type === "user") &&
        !(typeof t.id === "string" && UUID.test(t.id))
      ) {
        data.target = { type: t.type, id: SIM_PLACEHOLDER_ID };
        stubbed.add(n.id);
      }
    } else if (n.type === "send_notification") {
      const t = (data.target ?? {}) as { type?: string; id?: string };
      if (!(typeof t.id === "string" && t.id.trim() !== "")) {
        data.target = { type: "role", id: "(not chosen yet)" };
        stubbed.add(n.id);
      } else if ((t.type === "user" || t.type === "team") && !UUID.test(t.id)) {
        data.target = { type: "role", id: "(not chosen yet)" };
        stubbed.add(n.id);
      }
    }
    return { ...n, data };
  });
  for (const n of nodes) {
    if (n.type === "run_flow" && typeof n.data.flow_id === "string" && UUID.test(n.data.flow_id)) {
      nested.set(n.data.flow_id, {
        nodes: [
          { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
          { id: "end", type: "end_flow", position: { x: 0, y: 0 }, data: {} },
        ],
        edges: [
          { id: "trigger-default-end", source: "trigger", target: "end", sourceHandle: "default" },
        ],
      });
    }
  }
  return { graph: { nodes, edges: graph.edges }, stubbed, nested };
}

const CONVERSATION_TRIGGERS = new Set([
  "conversation_opened",
  "conversation_closed",
  "conversation_waiting",
  "template_button",
  "shortcut",
]);

function sampleTrigger(triggerType: string, now: Date): Record<string, unknown> {
  const starts = new Date(now.getTime() + 24 * 3_600_000).toISOString();
  if (triggerType.startsWith("appointment_"))
    return {
      event: triggerType,
      appointment: {
        starts_at: starts,
        status: "confirmed",
        doctor: "Dr Sample",
        location: "Main clinic",
      },
    };
  if (triggerType.startsWith("enquiry_")) return { event: triggerType };
  return { event: triggerType };
}

function describe(
  step: StepRecord,
  sim: { sent: Recorded[]; effects: Map<string, string> },
  stubbed: Set<string>,
): SimStepView {
  const outcome = (step.output?.__outcome ?? {}) as Outcome;
  const label =
    defFor(step.node_type)?.label ?? (step.node_type === "trigger" ? "Trigger" : step.node_type);
  const out: SimStepView = {
    seq: step.seq,
    nodeId: step.node_id,
    nodeType: step.node_type,
    label,
    outcome: step.status === "failed" ? "failed" : step.status === "waiting" ? "waiting" : "ok",
    detail: "",
  };
  if (stubbed.has(step.node_id)) out.stub = true;
  const sent = sim.sent.filter((s) => s.nodeId === step.node_id);
  if (outcome.kind === "fail") {
    out.detail = `Failed: ${outcome.error}`;
    return out;
  }
  if (outcome.kind === "next" && outcome.handle) out.handle = outcome.handle;
  switch (step.node_type) {
    case "trigger":
      out.detail = "The flow starts.";
      break;
    case "message":
    case "quick_reply":
      out.detail = sent.length
        ? `Would send: "${sent[sent.length - 1]!.text.slice(0, 160)}"`
        : "Nothing was sent.";
      break;
    case "question": {
      const answered =
        typeof step.output?.option_id === "string"
          ? ` The patient chose "${step.output.option_id}".`
          : step.status === "ok"
            ? " The patient answered."
            : "";
      out.detail = `Would ask: "${(sent[sent.length - 1]?.text ?? "").slice(0, 160)}" and wait for the answer.${answered}`;
      break;
    }
    case "template":
      out.detail = stubbed.has(step.node_id)
        ? "Would send a WhatsApp template (none chosen yet)."
        : "Would send the chosen WhatsApp template.";
      break;
    case "branch":
      out.detail = `The condition was ${outcome.kind === "next" && outcome.handle === "true" ? "true" : "false"}.`;
      break;
    case "wait":
      out.detail = "Waits, then continues (the dry run skips ahead in time).";
      break;
    case "office_hours":
      out.detail = `The clinic is ${outcome.kind === "next" && outcome.handle === "inside" ? "open" : "closed"} at this time.`;
      break;
    case "end_flow":
      out.detail = "The flow ends.";
      break;
    case "run_flow":
      out.detail = "Would run another flow (not simulated), then continue.";
      break;
    default:
      out.detail = sim.effects.get(step.node_id) ?? "Done.";
  }
  return out;
}

export async function simulateFlow(input: SimInput): Promise<SimResult> {
  const startAt = input.startAt ?? new Date();
  const clock = { now: new Date(startAt) };
  const { graph, stubbed, nested } = prepareGraphForSim(input.graph);
  const inbound = input.inbound
    .map((t) => t.trim().slice(0, SIM_LIMITS.maxMessageChars))
    .filter(Boolean)
    .slice(0, SIM_LIMITS.maxInbound);
  const hasConversation = CONVERSATION_TRIGGERS.has(input.triggerType);

  const contact: ContactView = {
    id: CONTACT,
    org_id: ORG,
    first_name: input.contact?.firstName ?? "Sample",
    last_name: "Patient",
    full_name: `${input.contact?.firstName ?? "Sample"} Patient`,
    email: null,
    gender: null,
    language: input.contact?.language ?? "en",
    label: null,
    stop_marketing: false,
    promotions_opt_in: true,
    has_phone: true,
    custom: {},
  };
  const conversation: ConversationView | null = hasConversation
    ? {
        id: CONV,
        org_id: ORG,
        channel_id: CHANNEL,
        contact_id: CONTACT,
        status: "open",
        bot_active: false,
        flow_run_id: null,
        last_inbound_at: clock.now.toISOString(),
        opened_at: clock.now.toISOString(),
        ad_referral: null,
        assignee_user_id: null,
        assignee_team_id: null,
      }
    : null;
  const templates = new Map<string, TemplateView>();
  for (const t of input.templates ?? [])
    templates.set(t.id, {
      id: t.id,
      name: t.name,
      status: t.status,
      category: t.category,
      components: [],
      variable_map: {},
    });
  templates.set(SIM_PLACEHOLDER_ID, {
    id: SIM_PLACEHOLDER_ID,
    name: "(template not chosen yet)",
    status: "APPROVED",
    category: "UTILITY",
    components: [],
    variable_map: {},
  });

  const flow: FlowView = {
    id: FLOW,
    org_id: ORG,
    name: "Dry run",
    status: "active",
    trigger_type: input.triggerType,
    trigger_config: input.triggerConfig ?? {},
    channel_id: null,
    version: 1,
    published_graph: graph,
  };
  const store = new SimStore(flow, contact, conversation, templates, nested);
  const actions = new SimActions();
  const queue: string[] = [];
  const timers: Array<{ runId: string; token: string; runAt: Date }> = [];
  let counter = 0;
  const deps: FlowDeps = {
    store,
    actions,
    jobs: {
      async enqueueStep(runId) {
        queue.push(runId);
      },
      async scheduleResume(i) {
        timers.push({ runId: i.runId, token: i.token, runAt: i.runAt });
      },
    },
    lock: new SimLock(),
    crm: simCrm(actions),
    now: () => clock.now,
    uuid: () => `00000000-0000-4000-8000-${String(++counter + 5000).padStart(12, "0")}`,
    timezone: input.timezone ?? "Asia/Dubai",
  };

  let next = 0;
  let unmatched = 0;
  const done = (status: SimResult["status"], reason: string): SimResult => ({
    status,
    reason,
    steps: [...store.steps].sort((a, b) => a.seq - b.seq).map((s) => describe(s, actions, stubbed)),
    sent: actions.sent,
    inboundUsed: next,
    inboundUnused: Math.max(0, inbound.length - next),
    unmatchedReplies: unmatched,
  });

  // --- does the trigger fire? -------------------------------------------------------------------------------------------
  if (hasConversation) {
    const first = inbound[0];
    if (
      input.triggerType !== "shortcut" &&
      input.triggerType !== "conversation_closed" &&
      first === undefined
    )
      return done(
        "not_started",
        "Add at least one sample message from the patient to start this flow.",
      );
    if (input.triggerType === "template_button") {
      const want = String(input.triggerConfig?.button_text ?? "")
        .trim()
        .toLowerCase();
      if (want && (first ?? "").trim().toLowerCase() !== want)
        return done(
          "not_started",
          `This flow starts when the patient taps the button "${want}". Type that as the first sample message.`,
        );
    }
    const cond = triggerConditionsSchema.safeParse(input.triggerConfig?.conditions ?? {});
    if (!cond.success) return done("not_started", "The trigger conditions are invalid.");
    if (!matchTriggerConditions(cond.data, { source: "direct", keyword: first ?? null, ad: null }))
      return done(
        "not_started",
        "The first sample message does not match the trigger's conditions, so the flow would not start.",
      );
    if (input.triggerType !== "shortcut" && input.triggerType !== "conversation_closed") next = 1; // the first message opened the conversation
  }

  const started = await startRun(deps, {
    flowId: FLOW,
    contactId: CONTACT,
    conversationId: hasConversation ? CONV : null,
    trigger: sampleTrigger(input.triggerType, clock.now),
  });
  if (!started.started) return done("not_started", "The flow could not start.");

  // --- run until it ends, waits for something the samples do not cover, or hits a limit ---------------------------------
  let iterations = 0;
  const runId = started.runId;
  const trackNode = async () => {
    const r = await store.getRun(runId);
    if (r?.current_node_id) actions.at(r.current_node_id);
  };

  while (iterations++ < SIM_LIMITS.maxIterations) {
    await trackNode();
    if (queue.length) {
      await advance(deps, queue.shift()!);
      continue;
    }
    const run = await store.getRun(runId);
    if (!run) break;
    if (run.status === "completed") return done("completed", "The flow reached its end.");
    if (run.status === "failed")
      return done(
        "failed",
        run.error?.startsWith("Stopped after")
          ? `${run.error}. A loop like this would never end live.`
          : (run.error ?? "A step failed."),
      );
    if (run.status === "cancelled") return done("stopped", "The flow was cancelled.");
    if (run.status === "waiting" && run.waiting_for) {
      const w = run.waiting_for;
      if (w.kind === "timer") {
        const timer = timers
          .filter((t) => t.runId === run.id && t.token === w.token)
          .sort((a, b) => a.runAt.getTime() - b.runAt.getTime())[0];
        if (timer && timer.runAt > clock.now) clock.now = new Date(timer.runAt);
        await resumeFromTimer(deps, run.id, w.token);
        continue;
      }
      if (w.kind === "reply") {
        const message = inbound[next];
        if (message === undefined)
          return done(
            "waiting",
            "The flow is waiting for the patient's answer. Add another sample message to carry on.",
          );
        next += 1;
        const byId = w.options.find((o) => o.id.toLowerCase() === message.toLowerCase());
        const r = await resumeFromReply(deps, run.id, {
          kind: byId ? "button" : "text",
          text: message,
          optionId: byId?.id ?? null,
        });
        if (!r.resumed && r.reason === "unmatched_reply") unmatched += 1; // the engine keeps waiting for a valid answer
        continue;
      }
      if (w.kind === "child") {
        // A nested flow resolves by itself; if nothing is queued it cannot move.
        if (!queue.length) return done("stopped", "A nested flow did not finish.");
        continue;
      }
    }
    break;
  }
  return done("stopped", `The dry run stopped after ${SIM_LIMITS.maxIterations} steps.`);
}
