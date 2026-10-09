/**
 * Ports the engine talks to. Production wiring is in `supabase-deps.ts`; unit tests use the
 * in-memory fakes in tests/unit/flow-fakes.ts. Executors never touch Supabase directly.
 */
import type { FlowGraph, RunContext, RunStatus, StepStatus, WaitingFor } from "@/lib/flow-engine/types";
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
  updateRun(runId: string, patch: Partial<Omit<RunRecord, "id" | "org_id">> & { ended_at?: string | null }): Promise<void>;
  /** Insert-or-return-existing on (run_id, seq). */
  insertStep(step: {
    run_id: string;
    org_id: string;
    seq: number;
    node_id: string;
    node_type: string;
    input: Record<string, unknown> | null;
  }): Promise<{ step: StepRecord; created: boolean }>;
  updateStep(stepId: string, patch: { status: StepStatus; output?: Record<string, unknown> | null; error?: string | null }): Promise<void>;
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
  setConversationBot(conversationId: string, patch: { bot_active?: boolean; flow_run_id?: string | null }): Promise<void>;
}

export type SendResult = { messageId: string };

export interface FlowActions {
  send(run: RunRecord, spec: SendSpec, body: string | null): Promise<SendResult>;
  assign(run: RunRecord, target: { type: "user" | "team" | "bot" | "unassign"; id?: string }): Promise<void>;
  closeConversation(run: RunRecord): Promise<void>;
  addComment(run: RunRecord, body: string): Promise<void>;
  updateContactField(run: RunRecord, field: string, value: string): Promise<void>;
  notify(run: RunRecord, target: { type: "user" | "team" | "role"; id?: string }, title: string, body: string): Promise<number>;
  /** SSRF-guarded HTTP call. Never logs headers or bodies. */
  http(req: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
    timeoutMs: number;
  }): Promise<{ status: number; body: unknown }>;
}

/** CRM modules that arrive with Phases 5–7. Absent adapter = the node fails with a clear message. */
export interface CrmPort {
  createEnquiry?(run: RunRecord, input: Record<string, unknown>): Promise<{ id: string }>;
  addTask?(run: RunRecord, input: Record<string, unknown>): Promise<{ id: string }>;
  upsertPortalRecord?(run: RunRecord, input: Record<string, unknown>): Promise<{ id: string }>;
  bookAppointment?(run: RunRecord, input: Record<string, unknown>): Promise<{ id: string }>;
}

export interface FlowJobs {
  /** Enqueue the next `flow_steps` job for a run (one job per node). */
  enqueueStep(runId: string, opts?: { delaySeconds?: number }): Promise<void>;
  /** Schedule a timer/timeout resume (scheduled_jobs, never in-memory timers). */
  scheduleResume(input: { orgId: string; runId: string; token: string; runAt: Date }): Promise<void>;
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
