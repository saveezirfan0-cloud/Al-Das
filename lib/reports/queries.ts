import type { Kpi, ReportContext, ReportResult } from "@/lib/reports/types";

/**
 * One function per live report. Each calls the SQL functions from the report-functions migration
 * (bounded, aggregated results) and shapes them into a ReportResult. No PHI: only counts, times and
 * staff names.
 */

const arr = <T,>(a: T[]): T[] | undefined => (a.length ? a : undefined);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const orZero = (v: unknown): number => Number(v ?? 0);

async function rpc<T>(promise: PromiseLike<{ data: T | null; error: { code?: string } | null }>, what: string): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(`${what} failed (${error.code ?? "unknown"})`);
  return (data ?? ([] as unknown)) as T;
}

function base(ctx: ReportContext) {
  return { p_org: ctx.orgId, p_from: ctx.range.fromDay, p_to: ctx.range.toDay };
}

export async function conversationsReport(ctx: ReportContext): Promise<ReportResult> {
  const { admin, filters } = ctx;
  const args = { ...base(ctx), p_channels: arr(filters.channel_ids), p_teams: arr(filters.team_ids) };
  const [summary, byDay, byChannel, heat] = await Promise.all([
    rpc(admin.rpc("report_conversations_summary", args), "conversations summary"),
    rpc(admin.rpc("report_conversations_by_day", args), "conversations by day"),
    rpc(admin.rpc("report_conversations_by_channel", args), "conversations by channel"),
    rpc(admin.rpc("report_heatmap", { ...base(ctx), p_channels: arr(filters.channel_ids) }), "heatmap"),
  ]);
  const s = summary[0];
  const returningShare = s && s.unique_contacts > 0 ? s.returning_contacts / s.unique_contacts : null;
  const kpis: Kpi[] = [
    { key: "conversations", label: "Conversations", value: orZero(s?.conversations), format: "number", hint: "opened in the period" },
    { key: "unique", label: "Unique contacts", value: orZero(s?.unique_contacts), format: "number" },
    { key: "returning", label: "Returning contacts", value: orZero(s?.returning_contacts), format: "number", hint: returningShare === null ? undefined : `${Math.round(returningShare * 100)}% of contacts` },
    { key: "closed", label: "Closed", value: orZero(s?.closed), format: "number" },
    { key: "open", label: "Still open", value: orZero(s?.still_open), format: "number" },
    { key: "in", label: "Patient messages", value: orZero(s?.inbound_messages), format: "number" },
    { key: "out", label: "Replies and automated messages", value: orZero(s?.outbound_messages), format: "number" },
  ];
  const notes: string[] = [];
  if (filters.team_ids.length) notes.push("Daily message volume ignores the team filter; conversation counts honour it.");
  return {
    kpis,
    charts: [
      {
        kind: "bars",
        title: "Conversations per day",
        xKey: "day",
        series: [
          { key: "opened", label: "Opened" },
          { key: "closed", label: "Closed" },
        ],
        data: byDay.map((d) => ({ day: d.day, opened: d.opened, closed: d.closed })),
      },
      { kind: "hbars", title: "By WhatsApp number", items: byChannel.map((c) => ({ label: c.channel_name, value: c.conversations })) },
      { kind: "heatmap", title: "When patients write", description: "Patient messages by weekday and hour, in your workspace timezone.", cells: heat.map((h) => ({ dow: h.dow, hour: h.hour, value: h.inbound_messages })) },
    ],
    table: {
      columns: [
        { key: "day", label: "Day" },
        { key: "opened", label: "Opened", format: "number" },
        { key: "closed", label: "Closed", format: "number" },
        { key: "inbound_messages", label: "Patient messages", format: "number" },
        { key: "outbound_messages", label: "Replies and automated", format: "number" },
      ],
      rows: byDay.map((d) => ({ day: d.day, opened: d.opened, closed: d.closed, inbound_messages: d.inbound_messages, outbound_messages: d.outbound_messages })),
    },
    notes,
  };
}

export async function responseReport(ctx: ReportContext): Promise<ReportResult> {
  const { admin, filters } = ctx;
  const rows = await rpc(
    admin.rpc("report_response_summary", { ...base(ctx), p_channels: arr(filters.channel_ids), p_teams: arr(filters.team_ids) }),
    "response summary",
  );
  const r = rows[0];
  const total = orZero(r?.conversations);
  const answered = orZero(r?.answered);
  const unanswered = orZero(r?.unanswered);
  const buckets = [
    { label: "Within 5 minutes", value: orZero(r?.within_5m) },
    { label: "5 to 15 minutes", value: orZero(r?.within_15m) },
    { label: "15 minutes to 1 hour", value: orZero(r?.within_1h) },
    { label: "1 to 4 hours", value: orZero(r?.within_4h) },
    { label: "Over 4 hours", value: orZero(r?.over_4h) },
    { label: "No staff reply yet", value: unanswered },
  ];
  return {
    kpis: [
      { key: "median", label: "Median first response", value: num(r?.fr_median_seconds), format: "duration" },
      { key: "avg", label: "Average first response", value: num(r?.fr_avg_seconds), format: "duration" },
      { key: "p90", label: "90th percentile", value: num(r?.fr_p90_seconds), format: "duration", hint: "9 in 10 were answered faster" },
      { key: "res_median", label: "Median time to close", value: num(r?.res_median_seconds), format: "duration" },
      { key: "res_avg", label: "Average time to close", value: num(r?.res_avg_seconds), format: "duration" },
      { key: "answered", label: "Answered by staff", value: total > 0 ? answered / total : null, format: "percent", hint: `${answered} of ${total} conversations` },
      { key: "unanswered", label: "Waiting for a staff reply", value: unanswered, format: "number" },
    ],
    charts: [{ kind: "hbars", title: "How fast patients get a first reply", description: "Conversations opened in the period, by time to the first reply from a staff member (automated replies do not count).", items: buckets }],
    table: {
      columns: [
        { key: "bucket", label: "First reply" },
        { key: "conversations", label: "Conversations", format: "number" },
        { key: "share", label: "Share", format: "percent" },
      ],
      rows: buckets.map((b) => ({ bucket: b.label, conversations: b.value, share: total > 0 ? b.value / total : null })),
    },
    notes: ["Time to close is measured from when the conversation opened to when it was closed."],
  };
}

export async function agentsReport(ctx: ReportContext): Promise<ReportResult> {
  const { admin, filters } = ctx;
  const rows = await rpc(
    admin.rpc("report_agents", { ...base(ctx), p_users: arr(filters.user_ids), p_teams: arr(filters.team_ids) }),
    "agent performance",
  );
  const totalSent = rows.reduce((s, r) => s + r.messages_sent, 0);
  const totalFr = rows.reduce((s, r) => s + r.first_responses, 0);
  const weighted = totalFr > 0 ? rows.reduce((s, r) => s + Number(r.avg_first_response_seconds ?? 0) * r.first_responses, 0) / totalFr : null;
  const name = (r: { name: string | null }) => r.name ?? "Former team member";
  return {
    kpis: [
      { key: "agents", label: "Active staff", value: rows.length, format: "number", hint: "sent at least one message" },
      { key: "sent", label: "Messages sent", value: totalSent, format: "number" },
      { key: "first", label: "First replies", value: totalFr, format: "number" },
      { key: "avg", label: "Average first response", value: weighted, format: "duration" },
      { key: "closed", label: "Conversations closed", value: rows.reduce((s, r) => s + r.conversations_closed, 0), format: "number" },
    ],
    charts: [{ kind: "hbars", title: "Messages sent by staff member", items: rows.slice(0, 15).map((r) => ({ label: name(r), value: r.messages_sent })) }],
    table: {
      columns: [
        { key: "name", label: "Staff member" },
        { key: "messages_sent", label: "Messages sent", format: "number" },
        { key: "first_responses", label: "First replies", format: "number" },
        { key: "avg_first_response_seconds", label: "Avg first response", format: "duration" },
        { key: "conversations_closed", label: "Closed", format: "number" },
        { key: "avg_resolution_seconds", label: "Avg time to close", format: "duration" },
      ],
      rows: rows.map((r) => ({
        name: name(r),
        messages_sent: r.messages_sent,
        first_responses: r.first_responses,
        avg_first_response_seconds: num(r.avg_first_response_seconds),
        conversations_closed: r.conversations_closed,
        avg_resolution_seconds: num(r.avg_resolution_seconds),
      })),
    },
    notes: [
      "A first reply is credited to whoever sent it. Automated messages are not attributed to anyone.",
      ...(filters.channel_ids.length ? ["The channel filter does not apply to this report."] : []),
    ],
  };
}

export async function whatsappUsageReport(ctx: ReportContext): Promise<ReportResult> {
  const { admin, filters } = ctx;
  const args = { ...base(ctx), p_channels: arr(filters.channel_ids) };
  const [byDay, totals] = await Promise.all([
    rpc(admin.rpc("report_usage_by_day", args), "usage by day"),
    rpc(admin.rpc("report_usage_totals", args), "usage totals"),
  ]);
  const sum = (f: (t: (typeof totals)[number]) => boolean) => totals.filter(f).reduce((s, t) => s + t.messages, 0);
  const all = sum(() => true);
  const failed = sum((t) => t.status === "failed");
  const byStatus = new Map<string, number>();
  for (const t of totals) byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + t.messages);
  return {
    kpis: [
      { key: "total", label: "Messages sent", value: all, format: "number" },
      { key: "template", label: "Template messages", value: sum((t) => t.category === "template"), format: "number" },
      { key: "free", label: "Free-form replies", value: sum((t) => t.category === "free_form"), format: "number", hint: "inside the 24-hour window" },
      { key: "failed", label: "Failed", value: failed, format: "number", hint: all > 0 ? `${Math.round((failed / all) * 1000) / 10}% of messages` : undefined },
    ],
    charts: [
      {
        kind: "bars",
        title: "Messages per day",
        xKey: "day",
        stacked: true,
        series: [
          { key: "template", label: "Template" },
          { key: "free_form", label: "Free-form" },
        ],
        data: byDay.map((d) => ({ day: d.day, template: d.template, free_form: d.free_form })),
      },
      { kind: "hbars", title: "By delivery status", items: [...byStatus.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label: label[0].toUpperCase() + label.slice(1), value })) },
    ],
    table: {
      columns: [
        { key: "day", label: "Day" },
        { key: "template", label: "Template", format: "number" },
        { key: "free_form", label: "Free-form", format: "number" },
        { key: "failed", label: "Failed", format: "number" },
      ],
      rows: byDay.map((d) => ({ day: d.day, template: d.template, free_form: d.free_form, failed: d.failed })),
    },
    notes: ["Cost is not shown yet: it needs Meta pricing analytics, which is not ingested. Counts are by message type."],
  };
}
