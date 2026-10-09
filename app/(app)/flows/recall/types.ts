export type ProgrammeView = {
  id: string;
  key: string;
  name: string;
  kind: string;
  eligibility: "chronic" | "birthday" | "visit_gap" | "managed";
  status: "draft" | "active" | "paused";
  cron: string | null;
  repeat: "once" | "per_cycle";
  maxPerRun: number;
  modeOverride: "test" | "live" | null;
  channelId: string | null;
  managedBy: string | null;
  config: Record<string, unknown>;
  templates: Array<{
    id: string;
    segment: string;
    waTemplateId: string | null;
    legacyId: string | null;
    variables: Record<string, string>;
    active: boolean;
  }>;
  lastRun: null | {
    at: string;
    dry: boolean;
    queued: number;
    scanned: number;
    skipped: Record<string, number>;
    bySegment: Record<string, number>;
    trigger: string;
    mode: string;
    gateOpen: boolean;
  };
  funnel: { sent: number; replied: number; booked: number; failed: number };
};

export type RecallBootstrap = {
  programmes: ProgrammeView[];
  waTemplates: Array<{
    id: string;
    name: string;
    language: string;
    status: string;
    category: string;
    clinical_approval: string;
  }>;
  channels: Array<{ id: string; name: string }>;
  gateOpen: boolean;
  workspaceMode: "test" | "live";
  minDays: number | null;
  canForceLive: boolean;
  canSeeCalls: boolean;
};

export const SKIP_LABEL: Record<string, string> = {
  no_template: "No template mapped for the segment",
  template_not_approved: "Template not approved by Meta",
  template_not_clinically_approved: "Template not clinically approved",
  clinical_gate_closed: "Clinical messaging is not signed off",
  band_not_covered: "Age / gender not covered by a band",
  no_segment: "No messageable condition group",
  stop_marketing: "Opted out of marketing",
  no_opt_in: "No marketing opt-in",
  no_destination: "No WhatsApp number",
  deleted: "Contact deleted",
  template_variables_missing: "Template variables not filled",
  no_active_channel: "No active number to send from",
  already_sent: "Already sent this cycle",
  queue_failed: "Could not be queued",
  contact_gone: "Contact no longer exists",
};
