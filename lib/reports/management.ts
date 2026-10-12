import {
  appointmentsReport,
  campaignsReport,
  conversationsReport,
  enquiryFunnelReport,
  responseReport,
  whatsappUsageReport,
} from "@/lib/reports/queries";
import { REPORTS, reportStatus } from "@/lib/reports/registry";
import type { Kpi, ReportContext, ReportResult } from "@/lib/reports/types";

/**
 * The numbers on the Management dashboard, in one place. The page renders them as tiles and charts and
 * the scheduled digest e-mail prints the same KPIs, so the two cannot drift apart: both call
 * loadManagementSummary() and both pick KPIs through MANAGEMENT_KPIS.
 */

export const MANAGEMENT_KPIS = {
  conversations: ["conversations", "unique", "returning"],
  response: ["median", "answered"],
  usage: ["total", "failed"],
  enquiries: ["created", "won", "lost", "conversion", "booked", "open"],
  appointments: ["total", "completed", "no_show", "rate"],
  campaigns: ["campaigns", "sent", "delivered", "read", "replied"],
} as const;

export type ManagementSummary = {
  /** Conversations, response performance and WhatsApp usage; null until the metrics migration is applied. */
  messaging: { conversations: ReportResult; response: ReportResult; usage: ReportResult } | null;
  enquiries: ReportResult | null;
  appointments: ReportResult | null;
  campaigns: ReportResult | null;
};

const pick = (r: ReportResult, keys: readonly string[]) =>
  r.kpis.filter((k) => keys.includes(k.key));

export async function loadManagementSummary(
  ctx: ReportContext,
  available: readonly string[],
): Promise<ManagementSummary> {
  const live = (key: string) =>
    reportStatus(
      REPORTS.find((r) => r.key === key)!,
      [...available],
    ) === "live";
  const messagingReady = ["conversations", "response", "whatsapp-usage"].every(live);
  const [messaging, appointments, enquiries, campaigns] = await Promise.all([
    messagingReady
      ? Promise.all([conversationsReport(ctx), responseReport(ctx), whatsappUsageReport(ctx)]).then(
          ([conversations, response, usage]) => ({ conversations, response, usage }),
        )
      : null,
    live("appointments") ? appointmentsReport(ctx) : null,
    live("enquiry-funnel") ? enquiryFunnelReport(ctx) : null,
    live("campaigns") ? campaignsReport(ctx) : null,
  ]);
  return { messaging, enquiries, appointments, campaigns };
}

/** The headline tiles at the top of the dashboard, in display order. */
export function headlineKpis(m: NonNullable<ManagementSummary["messaging"]>): Kpi[] {
  return [
    ...pick(m.conversations, MANAGEMENT_KPIS.conversations),
    ...pick(m.response, MANAGEMENT_KPIS.response),
    ...pick(m.usage, MANAGEMENT_KPIS.usage),
  ];
}

export type DigestSection = { title: string; kpis: Kpi[] };

/** Every section of the dashboard that has data, reduced to its KPI tiles. Used by the digest e-mail. */
export function summarySections(s: ManagementSummary): DigestSection[] {
  const out: DigestSection[] = [];
  if (s.messaging) out.push({ title: "Messaging", kpis: headlineKpis(s.messaging) });
  if (s.enquiries)
    out.push({ title: "Enquiries", kpis: pick(s.enquiries, MANAGEMENT_KPIS.enquiries) });
  if (s.appointments)
    out.push({ title: "Appointments", kpis: pick(s.appointments, MANAGEMENT_KPIS.appointments) });
  if (s.campaigns)
    out.push({ title: "Campaigns", kpis: pick(s.campaigns, MANAGEMENT_KPIS.campaigns) });
  return out;
}

export { pick as pickKpis };
