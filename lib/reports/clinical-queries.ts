import { addDays } from "@/lib/reports/range";
import type { Kpi, ReportContext, ReportResult } from "@/lib/reports/types";

/**
 * Phase 21 reports (docs/audit/reports.md §1.3, §1.5 and §3): appointment reminder statistics per doctor, recall
 * performance for one week, and the clinical operations load (Follow-Up Queue, red flags, data quality).
 * Each calls the service-role report_* functions from 20261027000100_phase21_clinical_gaps.sql. Counts and staff
 * (doctor) names only: no patient, phone number or message text ever reaches a report.
 */

async function rpc<T>(
  promise: PromiseLike<{ data: T | null; error: { code?: string } | null }>,
  what: string,
): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(`${what} failed (${error.code ?? "unknown"})`);
  return (data ?? ([] as unknown)) as T;
}

const ratio = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);

/** Monday of the ISO week that contains `ymd` (calendar arithmetic, YYYY-MM-DD). */
export function isoWeekStart(ymd: string): string {
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(ymd, -((dow + 6) % 7));
}

// ---------------------------------------------------------------------------
// Appointment reminders per doctor
// ---------------------------------------------------------------------------

export async function reminderStatsReport(ctx: ReportContext): Promise<ReportResult> {
  const args = { p_org: ctx.orgId, p_from: ctx.range.fromDay, p_to: ctx.range.toDay };
  const [bySpecialist, byDay] = await Promise.all([
    rpc(ctx.admin.rpc("report_reminder_stats_by_specialist", args), "reminder stats by doctor"),
    rpc(ctx.admin.rpc("report_reminder_stats_by_day", args), "reminder stats by day"),
  ]);
  const sum = (k: keyof (typeof bySpecialist)[number]) =>
    bySpecialist.reduce((s, r) => s + Number(r[k] ?? 0), 0);
  const appointments = sum("appointments");
  const contacted = sum("contacted");
  const sent = sum("reminders_sent");
  const kpis: Kpi[] = [
    {
      key: "sent",
      label: "Reminders sent",
      value: sent,
      format: "number",
      hint: "sent in the period",
    },
    {
      key: "delivered",
      label: "Delivered",
      value: sum("reminders_delivered"),
      format: "number",
      hint:
        sent > 0 ? `${Math.round((sum("reminders_delivered") / sent) * 100)}% of sent` : undefined,
    },
    { key: "read", label: "Read", value: sum("reminders_read"), format: "number" },
    {
      key: "replied",
      label: "Replied",
      value: sum("reminders_replied"),
      format: "number",
      hint: "a button tap or a reply quoting the reminder",
    },
    { key: "failed", label: "Failed", value: sum("reminders_failed"), format: "number" },
    {
      key: "contacted_rate",
      label: "Appointments contacted",
      value: ratio(contacted, appointments),
      format: "percent",
      hint: `${contacted} of ${appointments} appointments had a reminder sent`,
    },
  ];
  return {
    kpis,
    charts: [
      {
        kind: "bars",
        title: "Reminders per day",
        description: "By the day the reminder was sent, in your workspace timezone.",
        xKey: "day",
        series: [
          { key: "sent", label: "Sent" },
          { key: "delivered", label: "Delivered" },
          { key: "read", label: "Read" },
          { key: "replied", label: "Replied" },
        ],
        data: byDay.map((d) => ({
          day: d.day,
          sent: d.reminders_sent,
          delivered: d.reminders_delivered,
          read: d.reminders_read,
          replied: d.reminders_replied,
        })),
      },
      {
        kind: "hbars",
        title: "Reminders sent per doctor",
        items: bySpecialist
          .filter((r) => r.reminders_sent > 0)
          .slice(0, 15)
          .map((r) => ({ label: r.specialist_name, value: r.reminders_sent })),
      },
    ],
    table: {
      columns: [
        { key: "name", label: "Doctor" },
        { key: "appointments", label: "Appointments", format: "number" },
        { key: "contacted", label: "Contacted", format: "number" },
        { key: "contacted_rate", label: "% contacted", format: "percent" },
        { key: "sent", label: "Reminders sent", format: "number" },
        { key: "delivered", label: "Delivered", format: "number" },
        { key: "read", label: "Read", format: "number" },
        { key: "replied", label: "Replied", format: "number" },
        { key: "failed", label: "Failed", format: "number" },
        { key: "excluded", label: "Excluded", format: "number" },
      ],
      rows: bySpecialist.map((r) => ({
        name: r.specialist_name,
        appointments: r.appointments,
        contacted: r.contacted,
        contacted_rate: ratio(r.contacted, r.appointments),
        sent: r.reminders_sent,
        delivered: r.reminders_delivered,
        read: r.reminders_read,
        replied: r.reminders_replied,
        failed: r.reminders_failed,
        excluded: r.reminders_excluded,
      })),
    },
    notes: [
      "Appointments are counted by the day they take place (cancelled ones left out); reminders by the day they were sent. 'Contacted' means at least one reminder was sent for the appointment.",
      "Delivered and read come from WhatsApp delivery receipts; a patient who turned read receipts off is counted as delivered only.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Recall performance, one week
// ---------------------------------------------------------------------------

export async function recallWeekReport(ctx: ReportContext): Promise<ReportResult> {
  const week = isoWeekStart(ctx.range.toDay);
  const rows = await rpc(
    ctx.admin.rpc("report_recall_week", { p_org: ctx.orgId, p_week_start: week }),
    "recall week",
  );
  const live = rows.filter((r) => r.send_mode === "live");
  const sum = (list: typeof rows, k: "sent" | "failed" | "replied" | "booked") =>
    list.reduce((s, r) => s + Number(r[k] ?? 0), 0);
  const sent = sum(live, "sent");
  return {
    kpis: [
      {
        key: "sent",
        label: "Recalls sent",
        value: sent,
        format: "number",
        hint: `live, week of ${week}`,
      },
      { key: "replied", label: "Replied", value: sum(live, "replied"), format: "number" },
      { key: "booked", label: "Booked", value: sum(live, "booked"), format: "number" },
      {
        key: "booking_rate",
        label: "Booking rate",
        value: ratio(sum(live, "booked"), sent),
        format: "percent",
        hint: "target 30%",
      },
      { key: "failed", label: "Failed", value: sum(live, "failed"), format: "number" },
      {
        key: "test_sent",
        label: "Test-mode sends",
        value: sum(
          rows.filter((r) => r.send_mode !== "live"),
          "sent",
        ),
        format: "number",
        hint: "internal numbers only",
      },
    ],
    charts: [
      {
        kind: "hbars",
        title: "Recalls sent by programme",
        description: `Live sends in the week of ${week}.`,
        items: live.map((r) => ({ label: r.programme_name, value: r.sent })),
      },
    ],
    table: {
      columns: [
        { key: "programme", label: "Programme" },
        { key: "mode", label: "Mode" },
        { key: "sent", label: "Sent", format: "number" },
        { key: "replied", label: "Replied", format: "number" },
        { key: "booked", label: "Booked", format: "number" },
        { key: "failed", label: "Failed", format: "number" },
        { key: "patients", label: "Patients", format: "number" },
      ],
      rows: rows.map((r) => ({
        programme: r.programme_name,
        mode: r.send_mode,
        sent: r.sent,
        replied: r.replied,
        booked: r.booked,
        failed: r.failed,
        patients: r.unique_contacts,
      })),
    },
    notes: [
      `Recall weeks start on Monday (Asia/Dubai). This shows the week of ${week}, the week that contains the last day of the selected period.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Clinical operations: Follow-Up Queue load, red flags, data quality
// ---------------------------------------------------------------------------

const CATEGORY_LABEL: Record<string, string> = {
  paediatric_high_concern: "Paediatric high-concern",
  bleeding: "Bleeding",
  vitals: "Vitals",
  infection_labs: "Infection / labs",
  post_procedure: "Post-procedure",
  clinical_check: "Clinical check",
  other: "Other (sequence, feedback)",
};

export async function clinicalOperationsReport(ctx: ReportContext): Promise<ReportResult> {
  const period = { p_org: ctx.orgId, p_from: ctx.range.fromDay, p_to: ctx.range.toDay };
  const [load, flags, quality] = await Promise.all([
    rpc(
      ctx.admin.rpc("report_clinical_followup_load", {
        p_org: ctx.orgId,
        p_today: ctx.range.toDay,
      }),
      "follow-up load",
    ),
    rpc(ctx.admin.rpc("report_clinical_red_flags", period), "red flags"),
    rpc(ctx.admin.rpc("report_clinical_data_quality", period), "data quality"),
  ]);
  const total = (k: "open_items" | "high_priority" | "overdue" | "doctor_alerts_pending") =>
    load.reduce((s, r) => s + Number(r[k] ?? 0), 0);
  const f = flags[0];
  const q = quality[0];
  return {
    kpis: [
      {
        key: "open",
        label: "Open follow-ups",
        value: total("open_items"),
        format: "number",
        hint: "right now",
      },
      { key: "high", label: "High priority", value: total("high_priority"), format: "number" },
      {
        key: "overdue",
        label: "Overdue",
        value: total("overdue"),
        format: "number",
        hint: `due before ${ctx.range.toDay}`,
      },
      {
        key: "doctor_alerts",
        label: "Doctor alerts not yet sent",
        value: total("doctor_alerts_pending"),
        format: "number",
      },
      {
        key: "red_flags",
        label: "Red flags",
        value: Number(f?.red_flags ?? 0),
        format: "number",
        hint: "patient replies in the period",
      },
      {
        key: "needs_review",
        label: "Replies needing a person",
        value: Number(f?.needs_review ?? 0),
        format: "number",
      },
      {
        key: "incomplete_vitals",
        label: "Visits with incomplete vitals",
        value: Number(q?.incomplete_vitals ?? 0),
        format: "number",
        hint: q?.visits ? `of ${q.visits} visits in the period` : undefined,
      },
      {
        key: "unmatched",
        label: "Visits without a patient",
        value: Number(q?.unmatched_patients ?? 0),
        format: "number",
      },
      {
        key: "unclassified",
        label: "Unclassified medication codes",
        value: Number(q?.unclassified_medication_codes ?? 0),
        format: "number",
        hint: "no sequence fires until classified",
      },
      {
        key: "unknown_dx",
        label: "Diagnosis codes not in the reference",
        value: Number(q?.unknown_diagnosis_codes ?? 0),
        format: "number",
      },
    ],
    charts: [
      {
        kind: "hbars",
        title: "Open follow-ups by category",
        items: load.map((r) => ({
          label: CATEGORY_LABEL[r.trigger_category] ?? r.trigger_category,
          value: r.open_items,
        })),
      },
    ],
    table: {
      columns: [
        { key: "category", label: "Category" },
        { key: "open", label: "Open", format: "number" },
        { key: "high", label: "High priority", format: "number" },
        { key: "overdue", label: "Overdue", format: "number" },
        { key: "alerts", label: "Doctor alerts not sent", format: "number" },
      ],
      rows: load.map((r) => ({
        category: CATEGORY_LABEL[r.trigger_category] ?? r.trigger_category,
        open: r.open_items,
        high: r.high_priority,
        overdue: r.overdue,
        alerts: r.doctor_alerts_pending,
      })),
    },
    notes: [
      "The queue figures are a snapshot of now; red flags and visits follow the selected period. Test records are left out.",
    ],
  };
}
