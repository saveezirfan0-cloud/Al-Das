import "server-only";

import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

import { addDays } from "@/lib/documents/expiry";
import {
  addMonths,
  ageDays,
  closeMonthFor,
  dueOn,
  isWorkingDay,
  monthKpis,
  reminderMonths,
  remindersByRecipient,
  tasksToRemind,
  workingDay,
  type MonthKpi,
  type TaskStatus,
  type WorkCalendar,
} from "@/lib/finance/close-timetable";
import { memberIdsWithPermission, notify } from "@/lib/notify/dispatch-db";
import type { AdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";
import type { Json } from "@/lib/supabase/types";

/** Server side of the close timetable (Phase 20G). Service role; callers have run can() (or are the daily job). */

export type CloseCalendar = WorkCalendar & {
  /** First close month the timetable runs for (YYYY-MM-01); null = the timetable is OFF. */
  startMonth: string | null;
  inputsWd: number;
  deadlineWd: number;
  /** Calendar day (1-28) of the following month the close is due by; null = the working-day deadline. */
  deadlineDay: number | null;
  itemMaxAgeDays: number;
  /** Board pack thresholds (Phase 20G part 2) */
  revshareWd: number;
  voucherUnpaidDays: number;
  receivablesOver90Pct: number;
  /** docs/48: Diligence and Tally insurance receivable agree within this many dirhams. */
  insReceivableTolerance: number;
  holidayRows: { id: string; holidayOn: string; name: string }[];
};

export async function loadCloseCalendar(admin: AdminClient, orgId: string): Promise<CloseCalendar> {
  const [{ data: s }, { data: h }] = await Promise.all([
    admin
      .from("fin_ref_finance_settings")
      .select(
        "close_timetable_start, close_weekend_days, close_inputs_wd, close_deadline_wd, close_deadline_day, close_item_max_age_days, close_revshare_wd, close_voucher_unpaid_days, close_receivables_over90_pct, ins_receivable_tolerance",
      )
      .eq("org_id", orgId)
      .maybeSingle(),
    admin
      .from("fin_ref_holidays")
      .select("id, holiday_on, name")
      .eq("org_id", orgId)
      .order("holiday_on")
      .limit(1000),
  ]);
  const holidayRows = (h ?? []).map((r) => ({ id: r.id, holidayOn: r.holiday_on, name: r.name }));
  return {
    startMonth: s?.close_timetable_start ?? null,
    weekend: s?.close_weekend_days ?? [6, 7],
    holidays: holidayRows.map((r) => r.holidayOn),
    inputsWd: s?.close_inputs_wd ?? 5,
    deadlineWd: s?.close_deadline_wd ?? 10,
    deadlineDay: s?.close_deadline_day ?? null,
    itemMaxAgeDays: s?.close_item_max_age_days ?? 60,
    revshareWd: s?.close_revshare_wd ?? 7,
    voucherUnpaidDays: s?.close_voucher_unpaid_days ?? 14,
    receivablesOver90Pct: Number(s?.close_receivables_over90_pct ?? 25),
    insReceivableTolerance: Number(s?.ins_receivable_tolerance ?? 1),
    holidayRows,
  };
}

export type CloseJobTotals = { close_tasks_created: number; close_reminders: number };

/**
 * The daily part of finance_workflows. OFF until a start month is set. From working day 1 of a month it makes the
 * previous month's close tasks (idempotent), and on working days it sends ONE notification per person for their steps
 * that are due today or overdue, in that close month and in the two before it while they are not locked. Each task is claimed for the day in the database first, so a retry never notifies twice.
 */
export async function runCloseTimetable(
  admin: AdminClient,
  org: { id: string; timezone: string | null },
  now: Date,
  totals: CloseJobTotals,
): Promise<void> {
  const cal = await loadCloseCalendar(admin, org.id);
  if (!cal.startMonth) return;
  const today = formatInTimeZone(now, org.timezone || "UTC", "yyyy-MM-dd");
  const month = closeMonthFor(today);
  if (month < cal.startMonth) return;
  const wd1 = workingDay(addMonths(month, 1), 1, cal);
  if (!wd1 || today < wd1) return;

  const gen = await admin.rpc("fin_close_generate_tasks", { p_org_id: org.id, p_month: month });
  if (gen.error) throw new Error(`close tasks: ${gen.error.code ?? "unknown"}`);
  totals.close_tasks_created += Number(gen.data ?? 0);

  if (!isWorkingDay(today, cal)) return;
  // this close month and the two before it while they are not locked (a late step of last month's close still counts)
  const months = reminderMonths(today, cal.startMonth);
  const { data: locks, error: lockError } = await admin
    .from("fin_period_closes")
    .select("month")
    .eq("org_id", org.id)
    .in("month", months)
    .not("locked_at", "is", null);
  if (lockError) throw new Error(`close locks: ${lockError.code ?? "unknown"}`);
  const locked = new Set((locks ?? []).map((l) => l.month));
  const open = months.filter((m) => !locked.has(m));
  if (open.length === 0) return;
  const { data: tasks, error } = await admin
    .from("fin_close_tasks")
    .select("id, month, status, due_wd")
    .eq("org_id", org.id)
    .in("month", open)
    .neq("status", "done");
  if (error) throw new Error(`close tasks: ${error.code ?? "unknown"}`);
  const ids = tasksToRemind(
    (tasks ?? []).map((t) => ({
      id: t.id,
      status: t.status as TaskStatus,
      dueOn: dueOn(t.month, t.due_wd, cal),
    })),
    today,
  );
  if (ids.length === 0) return;
  const claim = await admin.rpc("fin_close_claim_reminders", {
    p_org_id: org.id,
    p_task_ids: ids,
    p_today: today,
  });
  if (claim.error) throw new Error(`close reminders: ${claim.error.code ?? "unknown"}`);
  const claimed = claim.data ?? [];
  if (claimed.length === 0) return;
  const managers = claimed.some((c) => !c.owner_user_id)
    ? await memberIdsWithPermission(admin, org.id, "finance.close.manage")
    : [];
  for (const [userId, count] of remindersByRecipient(claimed, managers)) {
    await notify(admin, {
      orgId: org.id,
      userIds: [userId],
      event: "finance.close_due",
      type: "finance.close_due",
      title:
        count === 1 ? "A close step is due or overdue" : `${count} close steps are due or overdue`,
      body: "Open Finance, Close timetable to see which.",
      payload: { count } as NonNullable<Json>,
    });
    totals.close_reminders++;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The page: the close KPIs (deck slide 11)
// ---------------------------------------------------------------------------------------------------------------------

/** Calendar date of a timestamp in the clinic's timezone. */
const localDay = (ts: string | null, tz: string) =>
  ts ? formatInTimeZone(new Date(ts), tz, "yyyy-MM-dd") : null;

export type CloseKpis = {
  months: MonthKpi[];
  /** Open reconciling items: the open finance exceptions (bank items join with 20C). */
  items: { open: number; oldestDays: number | null; overLimit: number };
};

/** The last `count` close months ending at `latest`: inputs on time and delivery by the deadline, plus open items. */
export async function loadCloseKpis(
  admin: AdminClient,
  orgId: string,
  timezone: string,
  cal: CloseCalendar,
  today: string,
  latest: string,
  count = 7,
): Promise<CloseKpis> {
  const months = Array.from({ length: count }, (_, i) => addMonths(latest, -i));
  const oldest = months[months.length - 1];
  const cutoff = addDays(today, -cal.itemMaxAgeDays) ?? today;
  const open = () =>
    admin
      .from("ops_exceptions")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .in("status", ["open", "in_progress"]);
  const [{ data: tasks }, { data: closes }, all, over, { data: first }] = await Promise.all([
    // Counted per month, so every task is read in pages (PostgREST returns at most 1,000 per request).
    fetchAll((from, to) =>
      admin
        .from("fin_close_tasks")
        .select("month, status, due_wd, done_at")
        .eq("org_id", orgId)
        .gte("month", oldest)
        .lte("month", latest)
        .order("id")
        .range(from, to),
    ),
    admin
      .from("fin_period_closes")
      .select("month, locked_at")
      .eq("org_id", orgId)
      .gte("month", oldest)
      .lte("month", latest),
    open(),
    open().lt("opened_at", fromZonedTime(`${cutoff}T00:00:00`, timezone).toISOString()),
    admin
      .from("ops_exceptions")
      .select("opened_at")
      .eq("org_id", orgId)
      .in("status", ["open", "in_progress"])
      .order("opened_at")
      .limit(1),
  ]);
  const lockedOn: Record<string, string | null> = {};
  for (const c of closes ?? []) lockedOn[c.month] = localDay(c.locked_at, timezone);
  return {
    months: monthKpis({
      months,
      tasks: (tasks ?? []).map((t) => ({
        month: t.month,
        status: t.status as TaskStatus,
        dueWd: t.due_wd,
        dueOn: dueOn(t.month, t.due_wd, cal),
        doneOn: localDay(t.done_at, timezone),
      })),
      lockedOn,
      cal,
      inputsWd: cal.inputsWd,
      deadlineWd: cal.deadlineWd,
      deadlineDay: cal.deadlineDay,
      today,
    }),
    items: {
      open: all.count ?? 0,
      oldestDays: ageDays(localDay(first?.[0]?.opened_at ?? null, timezone), today),
      overLimit: over.count ?? 0,
    },
  };
}
