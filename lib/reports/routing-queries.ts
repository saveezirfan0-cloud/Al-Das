import { parsePresencePayload, presenceDurations } from "@/lib/reports/presence";
import type { Kpi, ReportContext, ReportResult } from "@/lib/reports/types";

/**
 * Phase 20c / G13 reports over the assignment and presence logs (20261025000100) and the report functions in
 * 20261108000300. Counts, seconds and staff names only: never patient details or message text.
 */

const arr = <T>(a: T[]): T[] | undefined => (a.length ? a : undefined);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const orZero = (v: unknown): number => Number(v ?? 0);
const share = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);

async function rpc<T>(
  promise: PromiseLike<{ data: T | null; error: { code?: string } | null }>,
  what: string,
): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(`${what} failed (${error.code ?? "unknown"})`);
  return (data ?? ([] as unknown)) as T;
}

function base(ctx: ReportContext) {
  return { p_org: ctx.orgId, p_from: ctx.range.fromDay, p_to: ctx.range.toDay };
}

const LOG_NOTE =
  "The assignment log starts when routing logs were switched on (Phase 20c); older conversations have no assignment record.";

/** Staff names for ids (profiles), "Unassigned" for null, "Former team member" when the profile is gone. */
async function staffNames(
  ctx: ReportContext,
  ids: Array<string | null>,
): Promise<(id: string | null) => string> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  const { data } = wanted.length
    ? await ctx.admin.from("profiles").select("id, first_name, last_name, email").in("id", wanted)
    : {
        data: [] as Array<{
          id: string;
          first_name: string;
          last_name: string;
          email: string | null;
        }>,
      };
  const map = new Map(
    (data ?? []).map((p) => [
      p.id,
      `${p.first_name} ${p.last_name}`.trim() || p.email || "Unnamed",
    ]),
  );
  return (id) => (id ? (map.get(id) ?? "Former team member") : "Unassigned");
}

export async function assignmentCloseReport(ctx: ReportContext): Promise<ReportResult> {
  const { admin, filters } = ctx;
  const rows = await rpc(
    admin.rpc("report_assignment_close", {
      ...base(ctx),
      p_teams: arr(filters.team_ids),
      p_users: arr(filters.user_ids),
    }),
    "assignment to close",
  );
  const total = rows.find((r) => r.is_total);
  const people = rows.filter((r) => !r.is_total);
  const name = await staffNames(
    ctx,
    people.map((r) => r.user_id),
  );
  const kpis: Kpi[] = [
    {
      key: "closed",
      label: "Conversations closed",
      value: orZero(total?.closed),
      format: "number",
    },
    {
      key: "with",
      label: "With an assignment record",
      value: orZero(total?.with_assignment),
      format: "number",
      hint:
        total && total.closed > 0
          ? `${Math.round((total.with_assignment / total.closed) * 100)}% of closed`
          : undefined,
    },
    {
      key: "first_median",
      label: "Median first assign to close",
      value: num(total?.first_median_seconds),
      format: "duration",
    },
    {
      key: "first_avg",
      label: "Average first assign to close",
      value: num(total?.first_avg_seconds),
      format: "duration",
    },
    {
      key: "last_median",
      label: "Median last assign to close",
      value: num(total?.last_median_seconds),
      format: "duration",
    },
    {
      key: "last_avg",
      label: "Average last assign to close",
      value: num(total?.last_avg_seconds),
      format: "duration",
    },
  ];
  return {
    kpis,
    charts: [
      {
        kind: "hbars",
        title: "Median last assign to close by owner",
        description: "Who held the conversation when it was closed.",
        format: "duration",
        items: people
          .filter((r) => r.last_median_seconds !== null)
          .slice(0, 15)
          .map((r) => ({ label: name(r.user_id), value: Number(r.last_median_seconds) })),
      },
    ],
    table: {
      columns: [
        { key: "owner", label: "Owner at close" },
        { key: "closed", label: "Closed", format: "number" },
        { key: "with_assignment", label: "With assignment record", format: "number" },
        { key: "first_median", label: "Median first assign to close", format: "duration" },
        { key: "first_avg", label: "Avg first assign to close", format: "duration" },
        { key: "last_median", label: "Median last assign to close", format: "duration" },
        { key: "last_avg", label: "Avg last assign to close", format: "duration" },
      ],
      rows: people.map((r) => ({
        owner: name(r.user_id),
        closed: r.closed,
        with_assignment: r.with_assignment,
        first_median: num(r.first_median_seconds),
        first_avg: num(r.first_avg_seconds),
        last_median: num(r.last_median_seconds),
        last_avg: num(r.last_avg_seconds),
      })),
    },
    notes: [
      "Conversations closed in the period. First assign: the first time it got an owner. Last assign: the last time it got a new owner before it was closed.",
      LOG_NOTE,
      ...(filters.channel_ids.length ? ["The channel filter does not apply to this report."] : []),
    ],
  };
}

export async function ownerRemovedReport(ctx: ReportContext): Promise<ReportResult> {
  const { admin, filters } = ctx;
  const rows = await rpc(
    admin.rpc("report_owner_removed", {
      ...base(ctx),
      p_teams: arr(filters.team_ids),
      p_users: arr(filters.user_ids),
    }),
    "owner removed",
  );
  const total = rows.find((r) => r.is_total);
  const people = rows.filter((r) => !r.is_total);
  const name = await staffNames(
    ctx,
    people.map((r) => r.user_id),
  );
  return {
    kpis: [
      {
        key: "removed",
        label: "Owner removed",
        value: orZero(total?.removed),
        format: "number",
        hint: "a conversation taken away from a person",
      },
      {
        key: "unassigned",
        label: "Unassigned",
        value: orZero(total?.unassigned),
        format: "number",
      },
      {
        key: "reassigned",
        label: "Reassigned to someone else",
        value: orZero(total?.reassigned),
        format: "number",
      },
      {
        key: "by_staff",
        label: "By a staff member",
        value: orZero(total?.by_staff),
        format: "number",
      },
      {
        key: "by_system",
        label: "By routing or automation",
        value: orZero(total?.by_routing_or_system),
        format: "number",
      },
    ],
    charts: [
      {
        kind: "hbars",
        title: "Conversations taken from each person",
        items: people.slice(0, 15).map((r) => ({ label: name(r.user_id), value: r.removed })),
      },
    ],
    table: {
      columns: [
        { key: "owner", label: "Previous owner" },
        { key: "removed", label: "Owner removed", format: "number" },
        { key: "unassigned", label: "Unassigned", format: "number" },
        { key: "reassigned", label: "Reassigned", format: "number" },
        { key: "by_staff", label: "By staff", format: "number" },
        { key: "by_system", label: "By routing or automation", format: "number" },
      ],
      rows: people.map((r) => ({
        owner: name(r.user_id),
        removed: r.removed,
        unassigned: r.unassigned,
        reassigned: r.reassigned,
        by_staff: r.by_staff,
        by_system: r.by_routing_or_system,
      })),
    },
    notes: [
      "Counted on the day the owner was removed. Off-boarding a member counts each conversation handed over.",
      LOG_NOTE,
      ...(filters.channel_ids.length ? ["The channel filter does not apply to this report."] : []),
    ],
  };
}

export async function aiEngagementReport(ctx: ReportContext): Promise<ReportResult> {
  const { admin, filters } = ctx;
  const rows = await rpc(
    admin.rpc("report_ai_engagement", {
      ...base(ctx),
      p_channels: arr(filters.channel_ids),
      p_teams: arr(filters.team_ids),
    }),
    "AI engagement",
  );
  const r = rows[0];
  const closed = orZero(r?.closed);
  const items = [
    { key: "ai_assisted", label: "AI draft used by staff", value: orZero(r?.ai_assisted) },
    { key: "bot_engaged", label: "A flow (bot) replied", value: orZero(r?.bot_engaged) },
    { key: "engaged", label: "AI or bot engaged", value: orZero(r?.engaged) },
    {
      key: "closed_without_human",
      label: "Closed without a staff reply",
      value: orZero(r?.closed_without_human),
    },
    {
      key: "handled_by_automation",
      label: "Handled by automation only",
      value: orZero(r?.handled_by_automation),
    },
    {
      key: "closed_without_reply",
      label: "Closed with no reply at all",
      value: orZero(r?.closed_without_reply),
    },
  ];
  const v = (k: string) => items.find((i) => i.key === k)!.value;
  return {
    kpis: [
      { key: "closed", label: "Conversations closed", value: closed, format: "number" },
      {
        key: "engaged",
        label: "AI or bot engaged",
        value: share(v("engaged"), closed),
        format: "percent",
        hint: `${v("engaged")} of ${closed}`,
      },
      { key: "ai", label: "AI draft used", value: v("ai_assisted"), format: "number" },
      { key: "bot", label: "Bot replied", value: v("bot_engaged"), format: "number" },
      {
        key: "no_human",
        label: "Closed without a staff reply",
        value: share(v("closed_without_human"), closed),
        format: "percent",
        hint: `${v("closed_without_human")} of ${closed}`,
      },
      {
        key: "automation",
        label: "Handled by automation only",
        value: v("handled_by_automation"),
        format: "number",
      },
    ],
    charts: [
      {
        kind: "hbars",
        title: "Closed conversations",
        items: items.map((i) => ({ label: i.label, value: i.value })),
      },
    ],
    table: {
      columns: [
        { key: "measure", label: "Closed conversations where" },
        { key: "conversations", label: "Conversations", format: "number" },
        { key: "share", label: "Share of closed", format: "percent" },
      ],
      rows: items.map((i) => ({
        measure: i.label,
        conversations: i.value,
        share: share(i.value, closed),
      })),
    },
    notes: [
      "Pulse AI only drafts (it never sends to patients): 'AI draft used' means a staff member used an AI suggestion in the conversation. 'Bot' means a flow sent at least one message.",
      "Closed without a staff reply: no outbound message sent by a person. Handled by automation only: of those, at least one automated message (flow, auto-reply, reminder or campaign) was sent.",
    ],
  };
}

export async function enquiryCohortReport(ctx: ReportContext): Promise<ReportResult> {
  const { admin, filters } = ctx;
  const rows = await rpc(
    admin.rpc("report_enquiry_cohorts", { ...base(ctx), p_users: arr(filters.user_ids) }),
    "enquiry cohorts",
  );
  const created = rows.reduce((s, r) => s + r.created, 0);
  const won = rows.reduce((s, r) => s + r.won, 0);
  const open = rows.reduce((s, r) => s + r.open, 0);
  const month = (m: string) => String(m).slice(0, 7);
  return {
    kpis: [
      { key: "created", label: "Enquiries created", value: created, format: "number" },
      { key: "won", label: "Won so far", value: won, format: "number" },
      { key: "win_rate", label: "Win rate so far", value: share(won, created), format: "percent" },
      { key: "open", label: "Still open", value: open, format: "number" },
    ],
    charts: [
      {
        kind: "bars",
        title: "Where each month's enquiries are now",
        xKey: "month",
        stacked: true,
        series: [
          { key: "won", label: "Won" },
          { key: "open", label: "Open" },
          { key: "lost", label: "Lost" },
          { key: "disqualified", label: "Disqualified" },
        ],
        data: rows.map((r) => ({
          month: month(r.month),
          won: r.won,
          open: r.open,
          lost: r.lost,
          disqualified: r.disqualified,
        })),
      },
    ],
    table: {
      columns: [
        { key: "month", label: "Created in" },
        { key: "created", label: "Created", format: "number" },
        { key: "open", label: "Open", format: "number" },
        { key: "won", label: "Won", format: "number" },
        { key: "lost", label: "Lost", format: "number" },
        { key: "disqualified", label: "Disqualified", format: "number" },
        { key: "win_rate", label: "Win rate", format: "percent" },
        { key: "won_value", label: "Won value", format: "number" },
        { key: "median_days", label: "Median days to close", format: "number" },
      ],
      rows: rows.map((r) => ({
        month: month(r.month),
        created: r.created,
        open: r.open,
        won: r.won,
        lost: r.lost,
        disqualified: r.disqualified,
        win_rate: share(r.won, r.created),
        won_value: num(r.won_value),
        median_days: num(r.median_days_to_close),
      })),
    },
    notes: [
      "Enquiries created in the period, grouped by the month they were created (workspace timezone), with their status today. Pick a longer custom range to compare more months.",
      ...(filters.user_ids.length
        ? ["The person filter matches the enquiry's current assignee."]
        : []),
      ...(filters.team_ids.length || filters.channel_ids.length
        ? ["The team and channel filters do not apply to this report."]
        : []),
    ],
  };
}

const MAX_STATUS_ROWS = 5000;

export async function memberStatusReport(ctx: ReportContext): Promise<ReportResult> {
  const { admin, filters, range } = ctx;
  let users = filters.user_ids;
  if (filters.team_ids.length) {
    const { data } = await admin
      .from("team_members")
      .select("user_id")
      .eq("org_id", ctx.orgId)
      .in("team_id", filters.team_ids);
    const inTeams = new Set((data ?? []).map((r) => r.user_id));
    users = users.length ? users.filter((u) => inTeams.has(u)) : [...inTeams];
    if (users.length === 0) users = ["00000000-0000-0000-0000-000000000000"];
  }
  const raw = await rpc(
    admin.rpc("report_presence_events", {
      p_org: ctx.orgId,
      p_from: range.fromUtc.toISOString(),
      p_to: range.toUtcExclusive.toISOString(),
      p_users: arr(users),
    }),
    "presence log",
  );
  const payload = parsePresencePayload(raw);
  const byUser = presenceDurations({
    seed: payload.seed,
    events: payload.events,
    fromDay: range.fromDay,
    toDay: range.toDay,
    timezone: ctx.timezone,
    now: new Date(),
  });
  const name = await staffNames(ctx, [...byUser.keys()]);

  const perUser = [...byUser.entries()].map(([user, days]) => {
    const t = { online: 0, away: 0, offline: 0 };
    for (const d of days.values()) {
      t.online += d.online;
      t.away += d.away;
      t.offline += d.offline;
    }
    return { user, label: name(user), ...t, days };
  });
  perUser.sort((a, b) => b.online - a.online || a.label.localeCompare(b.label));
  const totalOnline = perUser.reduce((s, u) => s + u.online, 0);
  const totalAway = perUser.reduce((s, u) => s + u.away, 0);
  const active = perUser.filter((u) => u.online + u.away > 0);

  const byDay = new Map<string, { online: number; away: number }>();
  for (const u of perUser)
    for (const [day, d] of u.days) {
      const x = byDay.get(day) ?? { online: 0, away: 0 };
      x.online += d.online;
      x.away += d.away;
      byDay.set(day, x);
    }

  const rows: Array<Record<string, string | number | null>> = [];
  for (const u of perUser)
    for (const [day, d] of [...u.days.entries()].sort(([a], [b]) => a.localeCompare(b)))
      if (d.online + d.away > 0)
        rows.push({ day, member: u.label, online: d.online, away: d.away, offline: d.offline });
  rows.sort(
    (a, b) =>
      String(a.day).localeCompare(String(b.day)) ||
      String(a.member).localeCompare(String(b.member)),
  );

  const notes = [
    "From each member's status changes: Online, Away (set by them or automatically when idle) and Offline (signed out or set to appear offline). Time before the status log started counts as each member's status at that point.",
    "Days with no online or away time are left out of the table.",
  ];
  if (payload.truncated)
    notes.push(
      "This period has more status changes than one report can hold; the latest days are incomplete. Pick a shorter period.",
    );
  if (rows.length > MAX_STATUS_ROWS)
    notes.push(
      `The table shows the first ${MAX_STATUS_ROWS} rows; narrow the period or the people filter for the rest.`,
    );
  if (filters.channel_ids.length) notes.push("The channel filter does not apply to this report.");

  return {
    kpis: [
      {
        key: "members",
        label: "Members online at some point",
        value: active.length,
        format: "number",
      },
      { key: "online", label: "Total online time", value: totalOnline, format: "duration" },
      { key: "away", label: "Total away time", value: totalAway, format: "duration" },
      {
        key: "avg",
        label: "Average online per member per day",
        value:
          active.length > 0 && range.days > 0 ? totalOnline / (active.length * range.days) : null,
        format: "duration",
      },
    ],
    charts: [
      {
        kind: "hbars",
        title: "Online time by member",
        format: "duration",
        items: active.slice(0, 15).map((u) => ({ label: u.label, value: u.online })),
      },
      {
        kind: "bars",
        title: "Online and away time per day",
        xKey: "day",
        stacked: true,
        format: "duration",
        series: [
          { key: "online", label: "Online" },
          { key: "away", label: "Away" },
        ],
        data: [...byDay.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([day, d]) => ({ day, online: d.online, away: d.away })),
      },
    ],
    table: {
      columns: [
        { key: "day", label: "Day" },
        { key: "member", label: "Member" },
        { key: "online", label: "Online", format: "duration" },
        { key: "away", label: "Away", format: "duration" },
        { key: "offline", label: "Offline", format: "duration" },
      ],
      rows: rows.slice(0, MAX_STATUS_ROWS),
    },
    notes,
  };
}
