/**
 * Ports the engine talks to. Production wiring is in `supabase-deps.ts`; unit tests use the
 * in-memory fakes in tests/unit/flow-fakes.ts. Executors never touch Supabase directly.
 */
import type {
  FlowGraph,
  RunContext,
  RunStatus,
  StepStatus,
  WaitingFor,
} from "@/lib/flow-engine/types";
import type { SendSpec } from "@/lib/inbox/send";

export type ContactView = {
  id: string;
  org_id: string;
  first_name: string;
  last_name: string;
  full_name: string;
  email: string | null;
  gender: string | null;
  language: string | null;
  label: string | null;
  stop_marketing: boolean;
  promotions_opt_in: boolean;
  has_phone: boolean;
  custom: Record<string, unknown>;
};

export type ConversationView = {
  id: string;
  org_id: string;
  channel_id: string;
  contact_id: string;
  status: "open" | "waiting" | "closed";
  bot_active: boolean;
  flow_run_id: string | null;
  last_inbound_at: string | null;
  opened_at: string;
  ad_referral: unknown | null;
  assignee_user_id: string | null;
  assignee_team_id: string | null;
  /** channels.type; flows run on WhatsApp conversations only (Phase 20e). Absent = whatsapp. */
  channel_type?: string | null;
};

export type TemplateView = {
  id: string;
  name: string;
  status: string;
  category: string;
  /** Meta components (for body text / variable discovery). */
  components: unknown;
  variable_map: Record<string, string>;
};

export type FlowView = {
  id: string;
  org_id: string;
  name: string;
  status: "draft" | "active" | "paused";
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  channel_id: string | null;
  version: number;
  published_graph: FlowGraph | null;
};

export type RunRecord = {
  id: string;
  org_id: string;
  flow_id: string;
  flow_version: number;
  contact_id: string | null;
  conversation_id: string | null;
  enquiry_id: string | null;
  status: RunStatus;
  current_node_id: string | null;
  context: RunContext;
  waiting_for: WaitingFor | null;
  step_count: number;
  parent_run_id: string | null;
  error: string | null;
};

export type StepRecord = {
  id: string;
  run_id: string;
  seq: number;
  node_id: string;
  node_type: string;
  status: StepStatus;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
};

export interface FlowStore {
  getRun(runId: string): Promise<RunRecord | null>;
  updateRun(
    runId: string,
    patch: Partial<Omit<RunRecord, "id" | "org_id">> & { ended_at?: string | null },
  ): Promise<void>;
  /** Insert-or-return-existing on (run_id, seq). */
  insertStep(step: {
    run_id: string;
    org_id: string;
    seq: number;
    node_id: string;
    node_type: string;
    input: Record<string, unknown> | null;
  }): Promise<{ step: StepRecord; created: boolean }>;
  updateStep(
    stepId: string,
    patch: { status: StepStatus; output?: Record<string, unknown> | null; error?: string | null },
  ): Promise<void>;
  /** Mark the latest 'waiting' step of a node finished (after a resume). */
  finishWaitingStep(runId: string, nodeId: string, output: Record<string, unknown>): Promise<void>;
  getGraph(flowId: string, version: number): Promise<FlowGraph | null>;
  getFlow(flowId: string): Promise<FlowView | null>;
  /** Returns null when the conversation already has a live top-level run (one bot run per conversation). */
  createRun(input: {
    org_id: string;
    flow_id: string;
    flow_version: number;
    contact_id: string | null;
    conversation_id: string | null;
    enquiry_id?: string | null;
    current_node_id: string;
    context: RunContext;
    parent_run_id?: string | null;
    started_by?: string | null;
  }): Promise<RunRecord | null>;
  getContact(contactId: string): Promise<ContactView | null>;
  getConversation(conversationId: string): Promise<ConversationView | null>;
  /** Enabled workspace variables as key → value. */
  getVariables(orgId: string): Promise<Record<string, string>>;
  getTemplate(orgId: string, templateId: string): Promise<TemplateView | null>;
  /** Live (running/waiting) top-level run of a conversation. */
  getLiveRunForConversation(conversationId: string): Promise<RunRecord | null>;
  setConversationBot(
    conversationId: string,
    patch: { bot_active?: boolean; flow_run_id?: string | null },
  ): Promise<void>;
  /** Active flows of an org for one trigger type (published only). */
  listActiveFlows(orgId: string, triggerType: string): Promise<FlowView[]>;
  getInboundMessage(messageId: string): Promise<InboundMessageView | null>;
  /** Text of the first inbound message of a conversation (the "keyword" trigger fact). */
  getFirstInboundText(conversationId: string): Promise<string | null>;
  /** True when a run of this flow started for this conversation at or after `since` (the message_received debounce). */
  hasRunSince(flowId: string, conversationId: string, since: Date): Promise<boolean>;
  /** Drip check for a segment join: the segment's drip flow and kind, and whether the contact is (still) a live member. */
  getSegmentDrip(
    segmentId: string,
    contactId: string,
  ): Promise<{
    org_id: string;
    kind: string;
    drip_flow_id: string | null;
    member: boolean;
  } | null>;
}

export type InboundMessageView = {
  id: string;
  conversation_id: string;
  contact_id: string | null;
  kind: string;
  body: string | null;
  /** interactive reply id (button_reply / list_reply / template quick-reply payload) */
  reply_id: string | null;
  /** template the patient tapped a button on, when it can be resolved */
  template_id: string | null;
  /** When the message was received (ISO). */
  at?: string | null;
  /** WhatsApp Flow (nfm_reply) answers, already flattened and size-capped (lib/flow-engine/wa-flow.ts). */
  form?: Record<string, string> | null;
  /** The flow_token the form was sent with, when present. */
  form_token?: string | null;
};

export type SendResult = { messageId: string };

/** `stepKey` is the step's idempotency key (flowStepKey): the same key always yields the same message, never a second one. */
export type SendOptions = { stepKey: string };

export interface FlowActions {
  send(run: RunRecord, spec: SendSpec, body: string | null, opts: SendOptions): Promise<SendResult>;
  assign(
    run: RunRecord,
    target: { type: "user" | "team" | "bot" | "unassign"; id?: string },
  ): Promise<void>;
  closeConversation(run: RunRecord): Promise<void>;
  addComment(run: RunRecord, body: string): Promise<void>;
  updateContactField(run: RunRecord, field: string, value: string): Promise<void>;
  notify(
    run: RunRecord,
    target: { type: "user" | "team" | "role"; id?: string },
    title: string,
    body: string,
  ): Promise<number>;
  /** SSRF-guarded HTTP call. Never logs headers or bodies. */
  http(req: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
    timeoutMs: number;
  }): Promise<{ status: number; body: unknown }>;
}

/** What a module adapter answers. `created: false` = an existing record was updated instead. */
export type CrmResult = { id: string; created?: boolean };

/** What the payment-link adapter reports: ids only, never the link, amount or a name. */
export type PaymentLinkResult = { ok: true; requestId: string } | { ok: false; error: string };

/** The Conversions API adapter's answer (lib/integrations/capi/server.ts queueCapiEvent, plus "no_ad_click"). */
export type MetaEventResult = { status: string };

/**
 * Modules outside the engine: CRM (enquiries, tasks, portal, appointments, labels), integrations (payment links, Conversions
 * API) and the intent labels. Production wiring: lib/flow-engine/crm-adapters.ts (built with the admin client in
 * supabase-deps.ts, so nothing depends on import order). Tests and the dry run pass their own. An absent method = the node
 * fails closed with a clear message.
 */
export interface CrmPort {
  createEnquiry?(run: RunRecord, input: Record<string, unknown>): Promise<CrmResult>;
  /** One change per call (stage, status, pipeline or field); the enquiry service emits its domain event once. */
  updateEnquiry?(run: RunRecord, input: Record<string, unknown>): Promise<CrmResult>;
  addTask?(run: RunRecord, input: Record<string, unknown>): Promise<CrmResult>;
  upsertPortalRecord?(run: RunRecord, input: Record<string, unknown>): Promise<CrmResult>;
  /** `opts.stepKey` makes a replayed step get its booking back (appointments.flow_step_key) instead of booking again. */
  bookAppointment?(
    run: RunRecord,
    input: Record<string, unknown>,
    opts: SendOptions,
  ): Promise<CrmResult>;
  /** Adds or removes a conversation label (tags with scope 'conversation'). */
  setConversationLabel?(
    run: RunRecord,
    input: { tag_id: string; on: boolean },
  ): Promise<{ changed: boolean }>;
  /** `opts.stepKey` makes a replayed step return the request it already sent instead of failing on the open link. */
  createPaymentLink?(
    run: RunRecord,
    input: { invoice_number: string; amount: string },
    opts: SendOptions,
  ): Promise<PaymentLinkResult>;
  sendMetaEvent?(run: RunRecord, input: { event_name: string }): Promise<MetaEventResult>;
  /** The newest inbound message of the run's conversation (its text stays in memory; it is never stored by the router). */
  lastInbound?(run: RunRecord): Promise<{ messageId: string; body: string | null } | null>;
  /**
   * Intent labels for one message from the existing closed-enum pipeline (lib/ai/intent). null = not available (AI off,
   * no provider, daily cap, error): the router then takes its Else output.
   */
  intentsFor?(run: RunRecord, messageId: string): Promise<string[] | null>;
}

export interface FlowJobs {
  /** Enqueue the next `flow_steps` job for a run (one job per node). */
  enqueueStep(runId: string, opts?: { delaySeconds?: number }): Promise<void>;
  /** Schedule a timer/timeout resume (scheduled_jobs, never in-memory timers). */
  scheduleResume(input: {
    orgId: string;
    runId: string;
    token: string;
    runAt: Date;
  }): Promise<void>;
  /** Schedule a later trigger check (scheduled_jobs, one pending job per dedupe key), e.g. the window-closing trigger. */
  scheduleTrigger(input: {
    orgId: string;
    kind: string;
    payload: Record<string, string>;
    runAt: Date;
    dedupeKey: string;
  }): Promise<void>;
}

export interface FlowLock {
  claim(key: string, owner: string): Promise<boolean>;
  release(key: string, owner: string): Promise<void>;
}

export type FlowDeps = {
  store: FlowStore;
  actions: FlowActions;
  jobs: FlowJobs;
  lock: FlowLock;
  crm: CrmPort;
  now: () => Date;
  uuid: () => string;
  timezone: string;
};
