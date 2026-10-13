import {
  sumPerformance,
  templateRates,
  toPerformanceRows,
  TEMPLATE_PERFORMANCE_NOTES,
  type TemplatePerformanceRow,
} from "@/lib/templates/performance";
import type { AdminClient } from "@/lib/supabase/admin";
import type { ReportContext, ReportResult } from "@/lib/reports/types";

/** Read-only counts per template (public.report_template_performance). Callers run can() first. */
export async function fetchTemplatePerformance(
  admin: AdminClient,
  a: { orgId: string; from: string; to: string; channelIds?: string[]; templateId?: string },
): Promise<TemplatePerformanceRow[]> {
  const { data, error } = await admin.rpc("report_template_performance", {
    p_org: a.orgId,
    p_from: a.from,
    p_to: a.to,
    p_channels: a.channelIds?.length ? a.channelIds : undefined,
    p_template: a.templateId,
  });
  if (error) throw new Error(`template performance failed (${error.code ?? "unknown"})`);
  return toPerformanceRows(data);
}

/**
 * "Template performance" report (Phase 20d): per template, how many messages went out in the period and how many
 * were delivered, read, replied to, clicked (quick replies) and failed. Counts only, no patient data.
 */
export async function templatePerformanceReport(ctx: ReportContext): Promise<ReportResult> {
  const rows = await fetchTemplatePerformance(ctx.admin, {
    orgId: ctx.orgId,
    from: ctx.range.fromDay,
    to: ctx.range.toDay,
    channelIds: ctx.filters.channel_ids,
  });
  const total = sumPerformance(rows);
  const rates = templateRates(total);
  return {
    kpis: [
      { key: "messages", label: "Template messages", value: total.messages, format: "number" },
      {
        key: "delivered",
        label: "Delivered",
        value: rates.delivered,
        format: "percent",
        hint: "of sent",
      },
      { key: "read", label: "Read", value: rates.read, format: "percent", hint: "of delivered" },
      {
        key: "replied",
        label: "Replied",
        value: rates.replied,
        format: "percent",
        hint: "of delivered, within 24 h",
      },
      {
        key: "clicked",
        label: "Button clicks",
        value: rates.clicked,
        format: "percent",
        hint: "quick replies, of delivered",
      },
      {
        key: "failed",
        label: "Failed",
        value: rates.failed,
        format: "percent",
        hint: "of sent or failed",
      },
    ],
    charts: [
      {
        kind: "hbars",
        title: "Read by template",
        description: "Template messages the patient opened.",
        items: rows
          .slice(0, 15)
          .map((r) => ({ label: `${r.name} (${r.language})`, value: r.read_count })),
      },
    ],
    table: {
      columns: [
        { key: "name", label: "Template" },
        { key: "language", label: "Language" },
        { key: "category", label: "Category" },
        { key: "messages", label: "Messages", format: "number" },
        { key: "sent", label: "Sent", format: "number" },
        { key: "delivered", label: "Delivered", format: "number" },
        { key: "read_count", label: "Read", format: "number" },
        { key: "replied", label: "Replied", format: "number" },
        { key: "clicked", label: "Clicked", format: "number" },
        { key: "failed", label: "Failed", format: "number" },
        { key: "read_rate", label: "Read rate", format: "percent" },
      ],
      rows: rows.map((r) => ({
        name: r.name,
        language: r.language,
        category: r.category.toLowerCase(),
        messages: r.messages,
        sent: r.sent,
        delivered: r.delivered,
        read_count: r.read_count,
        replied: r.replied,
        clicked: r.clicked,
        failed: r.failed,
        read_rate: templateRates(r).read,
      })),
    },
    notes: [...TEMPLATE_PERFORMANCE_NOTES],
  };
}
