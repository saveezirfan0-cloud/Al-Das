import { agentsReport, conversationsReport, responseReport, whatsappUsageReport } from "@/lib/reports/queries";
import type { ReportDef } from "@/lib/reports/types";

/**
 * Every report, live or awaiting. A report with no `run` is listed as "Awaiting <phase>" with its
 * data contract in docs/audit/reports.md; wiring it in later means adding the views and a `run`.
 */
export const REPORTS: readonly ReportDef[] = [
  {
    key: "conversations",
    title: "Conversations",
    description: "Volume, new vs returning contacts, busiest hours and numbers.",
    group: "Conversations",
    filters: ["channel", "team"],
    requires: ["mv_conversation_facts", "mv_daily_conversations", "mv_hourly_conversations"],
    run: conversationsReport,
  },
  {
    key: "response",
    title: "Response performance",
    description: "How quickly patients get a first reply, and how long conversations take to close.",
    group: "Conversations",
    filters: ["channel", "team"],
    requires: ["mv_conversation_facts"],
    run: responseReport,
  },
  {
    key: "agents",
    title: "Agent performance",
    description: "Messages, first replies and closures per staff member.",
    group: "People",
    filters: ["team", "user"],
    requires: ["mv_agent_performance"],
    run: agentsReport,
  },
  {
    key: "whatsapp-usage",
    title: "WhatsApp usage",
    description: "Messages sent by type and delivery status. Cost follows once Meta pricing data is ingested.",
    group: "WhatsApp",
    filters: ["channel"],
    requires: ["mv_message_usage_daily"],
    run: whatsappUsageReport,
  },
  {
    key: "enquiry-funnel",
    title: "Enquiry funnel",
    description: "Enquiries created, moved, won and lost by stage.",
    group: "Enquiries",
    filters: ["team", "user"],
    requires: ["mv_enquiry_funnel"],
    awaiting: "Phase 5 (enquiries)",
  },
  {
    key: "enquiry-stage-time",
    title: "Time in stage",
    description: "Average time enquiries spend in each stage.",
    group: "Enquiries",
    filters: ["team", "user"],
    requires: ["mv_enquiry_stage_times"],
    awaiting: "Phase 5 (enquiries)",
  },
  {
    key: "campaigns",
    title: "Campaign performance",
    description: "Sent, delivered, read, replied and failed per campaign.",
    group: "Campaigns",
    filters: ["channel"],
    requires: ["mv_campaign_funnel"],
    awaiting: "Phase 7 (campaigns)",
  },
  {
    key: "appointments",
    title: "Appointments",
    description: "By status, location and specialist, including no-shows.",
    group: "Appointments",
    filters: [],
    requires: ["mv_appointments_by_status"],
    awaiting: "Phase 6 (appointments, plus the Unite status map, OQ-23)",
  },
  {
    key: "unite-appointments",
    title: "Unite appointments",
    description: "Appointments synced from the Unite EMR, by day.",
    group: "Appointments",
    filters: [],
    requires: ["mv_unite_appointments_daily"],
    awaiting: "Phase 6 (Unite read-only sync)",
  },
];

export function getReport(key: string): ReportDef | undefined {
  return REPORTS.find((r) => r.key === key);
}

/** Live = has an implementation AND every source view exists. */
export function reportStatus(def: ReportDef, available: readonly string[]): "live" | "awaiting" | "unavailable" {
  if (!def.run) return "awaiting";
  return def.requires.every((v) => available.includes(v)) ? "live" : "unavailable";
}
