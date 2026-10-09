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

const STATUS_SERIES = [
  { key: "completed", label: "Completed" },
  { key: "confirmed", label: "Confirmed" },
  { key: "awaiting", label: "Awaiting" },
  { key: "cancelled", label: "Cancelled" },
  { key: "no_show", label: "No-show" },
];

/** No-show rate = no-shows / (completed + no-shows): of appointments with an outcome, how many were missed. */
function noShowRate(completed: number, noShow: number): number | null {
  return completed + noShow > 0 ? noShow / (completed + noShow) : null;
}

export async function appointmentsReport(ctx: ReportContext): Promise<ReportResult> {
  const { admin } = ctx;
  const args = base(ctx);
  const [summary, byDay, byLocation, bySpecialist] = await Promise.all([
    rpc(admin.rpc("report_appointments_summary", args), "appointments summary"),
    rpc(admin.rpc("report_appointments_by_day", args), "appointments by day"),
    rpc(admin.rpc("report_appointments_by_location", args), "appointments by location"),
    rpc(admin.rpc("report_appointments_by_specialist", args), "appointments by specialist"),
  ]);
  const s = summary[0];
  const rate = noShowRate(orZero(s?.completed), orZero(s?.no_show));
  const dim = (r: { total: number; completed: number; cancelled: number; no_show: number }) => ({
    total: r.total,
    completed: r.completed,
    cancelled: r.cancelled,
    no_show: r.no_show,
    no_show_rate: noShowRate(r.completed, r.no_show),
  });
  const columns = (label: string) => [
    { key: "name", label },
    { key: "total", label: "Appointments", format: "number" as const },
    { key: "completed", label: "Completed", format: "number" as const },
    { key: "cancelled", label: "Cancelled", format: "number" as const },
    { key: "no_show", label: "No-shows", format: "number" as const },
    { key: "no_show_rate", label: "No-show rate", format: "percent" as const },
  ];
  return {
    kpis: [
      { key: "total", label: "Appointments", value: orZero(s?.total), format: "number", hint: "scheduled in the period" },
      { key: "completed", label: "Completed", value: orZero(s?.completed), format: "number" },
      { key: "cancelled", label: "Cancelled", value: orZero(s?.cancelled), format: "number" },
      { key: "no_show", label: "No-shows", value: orZero(s?.no_show), format: "number" },
      { key: "rate", label: "No-show rate", value: rate, format: "percent", hint: "of completed + no-show" },
      { key: "open", label: "Not yet resolved", value: orZero(s?.awaiting) + orZero(s?.confirmed), format: "number", hint: "awaiting or confirmed" },
    ],
    charts: [
      {
        kind: "bars",
        title: "Appointments per day",
        description: "By the day the appointment takes place, in your workspace timezone.",
        xKey: "day",
        stacked: true,
        series: STATUS_SERIES,
        data: byDay.map((d) => ({ day: d.day, completed: d.completed, confirmed: d.confirmed, awaiting: d.awaiting, cancelled: d.cancelled, no_show: d.no_show })),
      },
      { kind: "hbars", title: "By location", items: byLocation.map((l) => ({ label: l.location_name, value: l.total })) },
      { kind: "hbars", title: "By specialist", items: bySpecialist.slice(0, 15).map((l) => ({ label: l.specialist_name, value: l.total })) },
    ],
    // The table is the per-specialist breakdown (the one clinic managers act on); locations are in the chart.
    table: {
      columns: columns("Specialist"),
      rows: bySpecialist.map((r) => ({ name: r.specialist_name, ...dim(r) })),
    },
    notes: [
      "Appointments synced from Unite stay 'Awaiting' until their status codes are mapped (Settings → Unite EMR, open question OQ-23), so no-shows from Unite are undercounted until then.",
    ],
  };
}

export async function uniteAppointmentsReport(ctx: ReportContext): Promise<ReportResult> {
  const { admin } = ctx;
  const args = base(ctx);
  const [byDay, codes] = await Promise.all([
    rpc(admin.rpc("report_unite_appointments_by_day", args), "Unite appointments by day"),
    rpc(admin.rpc("report_unite_status_codes", args), "Unite status codes"),
  ]);
  const total = byDay.reduce((s, d) => s + d.appointments, 0);
  const unmapped = byDay.reduce((s, d) => s + d.unmapped, 0);
  return {
    kpis: [
      { key: "total", label: "Unite appointments", value: total, format: "number", hint: "synced into Pulse" },
      { key: "unmapped", label: "With an unmapped status code", value: unmapped, format: "number", hint: total > 0 ? `${Math.round((unmapped / total) * 100)}% of the total` : undefined },
    ],
    charts: [
      {
        kind: "bars",
        title: "Unite appointments per day",
        xKey: "day",
        series: [{ key: "appointments", label: "Appointments" }],
        data: byDay.map((d) => ({ day: d.day, appointments: d.appointments })),
      },
      { kind: "hbars", title: "By Unite status code", items: codes.map((c) => ({ label: c.mapped_status ? `${c.code} (${c.mapped_status})` : `${c.code} (not mapped)`, value: c.appointments })) },
    ],
    table: {
      columns: [
        { key: "day", label: "Day" },
        { key: "appointments", label: "Appointments", format: "number" },
        { key: "unmapped", label: "Unmapped status", format: "number" },
      ],
      rows: byDay.map((d) => ({ day: d.day, appointments: d.appointments, unmapped: d.unmapped })),
    },
    notes: ["Unite is read-only: this shows what the sync has copied, not live Unite data. Map each status code in Settings → Unite EMR (OQ-23) to move appointments out of 'Awaiting'."],
  };
}

/** Won / (won + lost + disqualified), among enquiries closed in the period. */
function conversion(won: number, lost: number, disqualified: number): number | null {
  const closed = won + lost + disqualified;
  return closed > 0 ? won / closed : null;
}

function enquiryArgs(ctx: ReportContext) {
  return { ...base(ctx), p_users: arr(ctx.filters.user_ids), p_teams: arr(ctx.filters.team_ids) };
}

const ENQUIRY_NOTE =
  "Team and staff filters use each enquiry's current assignee; earlier assignees are not kept.";

export async function enquiryFunnelReport(ctx: ReportContext): Promise<ReportResult> {
  const { admin } = ctx;
  const args = enquiryArgs(ctx);
  const [summary, byDay, funnel] = await Promise.all([
    rpc(admin.rpc("report_enquiries_summary", args), "enquiries summary"),
    rpc(admin.rpc("report_enquiries_by_day", args), "enquiries by day"),
    rpc(admin.rpc("report_enquiry_funnel", args), "enquiry funnel"),
  ]);
  const s = summary[0];
  const won = orZero(s?.won);
  const lost = orZero(s?.lost);
  const disq = orZero(s?.disqualified);
  const label = (r: { pipeline_name: string; stage_name: string }) =>
    funnel.some((f) => f.pipeline_name !== r.pipeline_name) ? `${r.pipeline_name} · ${r.stage_name}` : r.stage_name;
  return {
    kpis: [
      { key: "created", label: "New enquiries", value: orZero(s?.created), format: "number", hint: "created in the period" },
      { key: "won", label: "Won", value: won, format: "number", hint: "closed in the period" },
      { key: "lost", label: "Lost", value: lost, format: "number" },
      { key: "disqualified", label: "Disqualified", value: disq, format: "number" },
      { key: "conversion", label: "Conversion", value: conversion(won, lost, disq), format: "percent", hint: "won of won + lost + disqualified" },
      { key: "open", label: "Open now", value: orZero(s?.open_now), format: "number", hint: "as of today, not the period" },
      { key: "value", label: "Won value", value: orZero(s?.won_value), format: "number", hint: "estimated value of won enquiries" },
    ],
    charts: [
      {
        kind: "bars",
        title: "Enquiries per day",
        xKey: "day",
        series: [
          { key: "created", label: "New" },
          { key: "won", label: "Won" },
          { key: "lost", label: "Lost" },
          { key: "disqualified", label: "Disqualified" },
        ],
        data: byDay.map((d) => ({ day: d.day, created: d.created, won: d.won, lost: d.lost, disqualified: d.disqualified })),
      },
      {
        kind: "hbars",
        title: "Entered each stage",
        description: "Enquiries that reached the stage during the period (from the enquiry timeline).",
        items: funnel.filter((f) => f.entered > 0).map((f) => ({ label: label(f), value: f.entered })),
      },
    ],
    table: {
      columns: [
        { key: "stage", label: "Stage" },
        { key: "entered", label: "Entered", format: "number" },
        { key: "open_now", label: "Open now", format: "number" },
        { key: "won_here", label: "Won here", format: "number" },
        { key: "lost_here", label: "Lost here", format: "number" },
        { key: "disqualified_here", label: "Disqualified here", format: "number" },
      ],
      rows: funnel.map((f) => ({
        stage: `${f.pipeline_name} · ${f.stage_name}`,
        entered: f.entered,
        open_now: f.open_now,
        won_here: f.won_here,
        lost_here: f.lost_here,
        disqualified_here: f.disqualified_here,
      })),
    },
    notes: [
      ENQUIRY_NOTE,
      "'Won here', 'Lost here' and 'Disqualified here' count enquiries closed in the period while sitting in that stage. Enquiries without timeline events (imported or created before this module) are not in 'Entered'.",
    ],
  };
}

export async function enquiryStageTimeReport(ctx: ReportContext): Promise<ReportResult> {
  const rows = await rpc(ctx.admin.rpc("report_enquiry_stage_times", enquiryArgs(ctx)), "time in stage");
  const stays = rows.reduce((sum, r) => sum + r.stays, 0);
  const weighted = stays > 0 ? rows.reduce((sum, r) => sum + Number(r.avg_seconds ?? 0) * r.stays, 0) / stays : null;
  const slowest = [...rows].sort((a, b) => Number(b.avg_seconds ?? 0) - Number(a.avg_seconds ?? 0))[0];
  const name = (r: { pipeline_name: string; stage_name: string }) => `${r.pipeline_name} · ${r.stage_name}`;
  return {
    kpis: [
      { key: "stays", label: "Completed stage stays", value: stays, format: "number", hint: "stages enquiries moved out of" },
      { key: "avg", label: "Average time in a stage", value: weighted, format: "duration" },
      { key: "slowest", label: "Slowest stage (average)", value: slowest ? num(slowest.avg_seconds) : null, format: "duration", hint: slowest ? name(slowest) : undefined },
    ],
    charts: [
      {
        kind: "hbars",
        title: "Average time in each stage",
        format: "duration",
        items: rows.filter((r) => r.avg_seconds !== null).map((r) => ({ label: name(r), value: Number(r.avg_seconds) })),
      },
    ],
    table: {
      columns: [
        { key: "stage", label: "Stage" },
        { key: "stays", label: "Stays", format: "number" },
        { key: "avg_seconds", label: "Average", format: "duration" },
        { key: "median_seconds", label: "Median", format: "duration" },
      ],
      rows: rows.map((r) => ({ stage: name(r), stays: r.stays, avg_seconds: num(r.avg_seconds), median_seconds: num(r.median_seconds) })),
    },
    notes: [
      ENQUIRY_NOTE,
      "A stay counts when the enquiry leaves the stage (or is closed) inside the period. The stage an open enquiry is in right now is not counted yet.",
    ],
  };
}

export async function campaignsReport(ctx: ReportContext): Promise<ReportResult> {
  const { admin, filters } = ctx;
  const rows = await rpc(admin.rpc("report_campaigns", { ...base(ctx), p_channels: arr(filters.channel_ids) }), "campaigns");
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + f(r), 0);
  const eligible = sum((r) => r.eligible);
  const rate = (n: number, of: number): number | null => (of > 0 ? n / of : null);
  return {
    kpis: [
      { key: "campaigns", label: "Campaigns", value: rows.length, format: "number" },
      { key: "sent", label: "Sent", value: sum((r) => r.sent), format: "number" },
      { key: "delivered", label: "Delivered", value: rate(sum((r) => r.delivered), sum((r) => r.sent)), format: "percent", hint: "of sent" },
      { key: "read", label: "Read", value: rate(sum((r) => r.read_count), sum((r) => r.delivered)), format: "percent", hint: "of delivered" },
      { key: "replied", label: "Replied", value: rate(sum((r) => r.replied), sum((r) => r.delivered)), format: "percent", hint: "of delivered" },
      { key: "failed", label: "Failed", value: rate(sum((r) => r.failed), eligible), format: "percent", hint: "of eligible recipients" },
    ],
    charts: [
      {
        kind: "hbars",
        title: "Read by campaign",
        description: "Recipients who read the message.",
        items: rows.slice(0, 15).map((r) => ({ label: r.name, value: r.read_count })),
      },
    ],
    table: {
      columns: [
        { key: "name", label: "Campaign" },
        { key: "status", label: "Status" },
        { key: "channel", label: "Number" },
        { key: "sent", label: "Sent", format: "number" },
        { key: "delivered", label: "Delivered", format: "number" },
        { key: "read_count", label: "Read", format: "number" },
        { key: "replied", label: "Replied", format: "number" },
        { key: "failed", label: "Failed", format: "number" },
        { key: "skipped", label: "Skipped", format: "number" },
      ],
      rows: rows.map((r) => ({
        name: r.name,
        status: r.status,
        channel: r.channel_name,
        sent: r.sent,
        delivered: r.delivered,
        read_count: r.read_count,
        replied: r.replied,
        failed: r.failed,
        skipped: r.skipped,
      })),
    },
    notes: ["Campaigns are placed in the period by the day they started (or were scheduled). Drafts are not listed. Skipped recipients (opted out, no number, missing variable) are not counted as failed."],
  };
}
