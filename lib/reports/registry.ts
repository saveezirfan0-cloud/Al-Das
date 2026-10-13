import {
  agentsReport,
  appointmentsReport,
  campaignsReport,
  conversationsReport,
  enquiryFunnelReport,
  enquiryStageTimeReport,
  responseReport,
  uniteAppointmentsReport,
  whatsappUsageReport,
} from "@/lib/reports/queries";
import {
  aiEngagementReport,
  assignmentCloseReport,
  enquiryCohortReport,
  memberStatusReport,
  ownerRemovedReport,
} from "@/lib/reports/routing-queries";
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
  // Phase 20c / G13: read the assignment and presence logs (20261025000100) through service-role report functions.
  {
    key: "assign-to-close",
    title: "Assignment to close",
    description: "Time from the first and the last assignment to closing a conversation.",
    group: "Conversations",
    filters: ["team", "user"],
    requires: ["v_conversation_engagement", "v_assignment_events"],
    run: assignmentCloseReport,
  },
  {
    key: "owner-removed",
    title: "Owner removed",
    description: "Conversations taken away from a person: unassigned or handed to someone else.",
    group: "Conversations",
    filters: ["team", "user"],
    requires: ["v_assignment_events"],
    run: ownerRemovedReport,
  },
  {
    key: "ai-engagement",
    title: "AI and automation",
    description: "Closed conversations where AI drafts or bots took part, and those closed without a staff reply.",
    group: "Conversations",
    filters: ["channel", "team"],
    requires: ["v_conversation_engagement"],
    run: aiEngagementReport,
  },
  {
    key: "member-status",
    title: "Member status log",
    description: "Online, away and offline time per member per day.",
    group: "People",
    filters: ["team", "user"],
    requires: ["v_presence_events"],
    run: memberStatusReport,
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
    requires: ["v_enquiry_facts", "v_enquiry_stage_entries"],
    run: enquiryFunnelReport,
  },
  {
    key: "enquiry-stage-time",
    title: "Time in stage",
    description: "Average time enquiries spend in each stage.",
    group: "Enquiries",
    filters: ["team", "user"],
    requires: ["v_enquiry_facts", "v_enquiry_stage_entries"],
    run: enquiryStageTimeReport,
  },
  {
    key: "enquiry-cohorts",
    title: "Enquiry cohorts",
    description: "Enquiries grouped by the month they were created, and where they are now.",
    group: "Enquiries",
    filters: ["user"],
    requires: ["v_enquiry_facts"],
    run: enquiryCohortReport,
  },
  {
    key: "campaigns",
    title: "Campaign performance",
    description: "Sent, delivered, read, replied and failed per campaign.",
    group: "Campaigns",
    filters: ["channel"],
    requires: ["v_campaign_facts"],
    run: campaignsReport,
  },
  {
    key: "appointments",
    title: "Appointments",
    description: "By status, location and specialist, including no-shows.",
    group: "Appointments",
    filters: [],
    requires: ["v_appointment_facts"],
    run: appointmentsReport,
  },
  {
    key: "unite-appointments",
    title: "Unite appointments",
    description: "Appointments synced from the Unite EMR, by day.",
    group: "Appointments",
    filters: [],
    requires: ["v_appointment_facts"],
    run: uniteAppointmentsReport,
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
