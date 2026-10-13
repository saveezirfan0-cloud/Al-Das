/**
 * Phase 20G: the daily close reminders also cover an earlier close month that is not locked yet (September's working
 * day 23 falls on 2 November, when the timetable is already on October's close), at most two months back, and never a
 * locked month. In-memory admin client; the notification dispatcher is a spy. Synthetic data only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const notify = vi.fn(async () => null);
vi.mock("@/lib/notify/dispatch-db", () => ({
  notify: (...a: unknown[]) => notify(...(a as [])),
  memberIdsWithPermission: async () => ["manager-1"],
}));

import { reminderMonths } from "@/lib/finance/close-timetable";
import { runCloseTimetable } from "@/lib/finance/close-timetable-server";
import type { AdminClient } from "@/lib/supabase/admin";

import { createFakeAdmin } from "../../helpers/fake-admin";

const ORG = "00000000-0000-4000-8000-000000000001";
// Monday 2 November 2026, 09:00 in Dubai: working day 1 of November, so October is the close month
const NOW = new Date("2026-11-02T05:00:00Z");

function setup(locked: string[] = [], start = "2026-06-01") {
  const task = (id: string, month: string, due_wd: number, status = "open") => ({
    id,
    org_id: ORG,
    month,
    due_wd,
    status,
  });
  const admin = createFakeAdmin(
    {
      fin_ref_finance_settings: [
        { org_id: ORG, close_timetable_start: start, close_weekend_days: [6, 7] },
      ],
      fin_ref_holidays: [],
      fin_period_closes: [
        ...locked.map((month) => ({ org_id: ORG, month, locked_at: "2026-10-30T10:00:00Z" })),
        { org_id: ORG, month: "2026-07-01", locked_at: null },
      ],
      fin_close_tasks: [
        task("oct-wd1", "2026-10-01", 1), // due today
        task("oct-wd5", "2026-10-01", 5), // not due yet
        task("oct-done", "2026-10-01", 1, "done"),
        task("sep-wd23", "2026-09-01", 23), // September's WD23 = 2 November
        task("sep-blocked", "2026-09-01", 10, "blocked"),
        task("sep-done", "2026-09-01", 3, "done"),
        task("aug-wd23", "2026-08-01", 23), // overdue since 1 October
        task("jul-wd10", "2026-07-01", 10), // three months back: out of range
      ],
    },
    {
      rpc: {
        fin_close_generate_tasks: () => 0,
        fin_close_claim_reminders: (a) =>
          (a.p_task_ids as string[]).map((id) => ({ task_id: id, owner_user_id: "owner-1" })),
      },
    },
  );
  return admin;
}

const claimedIds = (admin: ReturnType<typeof setup>) =>
  admin._calls
    .filter((c) => c.table === "rpc:fin_close_claim_reminders")
    .flatMap((c) => ((c.payload as { p_task_ids: string[] }).p_task_ids ?? []).slice())
    .sort();

describe("close reminders across close months", () => {
  beforeEach(() => notify.mockClear());

  it("covers the current close month and at most the two before it, never before the start", () => {
    expect(reminderMonths("2026-11-02", "2026-01-01")).toEqual([
      "2026-10-01",
      "2026-09-01",
      "2026-08-01",
    ]);
    expect(reminderMonths("2026-11-02", "2026-09-01")).toEqual(["2026-10-01", "2026-09-01"]);
    expect(reminderMonths("2027-01-04", "2026-01-01")).toEqual([
      "2026-12-01",
      "2026-11-01",
      "2026-10-01",
    ]);
  });

  it("reminds overdue steps of the two earlier close months that are not locked", async () => {
    const admin = setup();
    const totals = { close_tasks_created: 0, close_reminders: 0 };
    await runCloseTimetable(
      admin as unknown as AdminClient,
      { id: ORG, timezone: "Asia/Dubai" },
      NOW,
      totals,
    );
    expect(claimedIds(admin)).toEqual(["aug-wd23", "oct-wd1", "sep-blocked", "sep-wd23"]);
    expect(totals.close_reminders).toBe(1); // one notification for the one owner
    expect(notify).toHaveBeenCalledTimes(1);
    // the claim is still one call per day with the day passed, so a retry never notifies twice
    const claims = admin._calls.filter((c) => c.table === "rpc:fin_close_claim_reminders");
    expect(claims).toHaveLength(1);
    expect((claims[0].payload as { p_today: string }).p_today).toBe("2026-11-02");
  });

  it("never reminds a locked month, nor one before the timetable started", async () => {
    const admin = setup(["2026-09-01"], "2026-09-01");
    await runCloseTimetable(
      admin as unknown as AdminClient,
      { id: ORG, timezone: "Asia/Dubai" },
      NOW,
      { close_tasks_created: 0, close_reminders: 0 },
    );
    expect(claimedIds(admin)).toEqual(["oct-wd1"]);
  });
});
