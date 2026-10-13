/**
 * Phase 20I: the job wrapper around fin_followup_create_tasks. It notifies once per run with a fixed sentence and ids
 * (never a payer, amount or claim number), stays quiet when nothing was raised, and fails loudly (no notification) when
 * the database call fails. Fake client, no network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/notify/dispatch-db", () => ({
  memberIdsWithPermission: async (_a: unknown, _o: string, perm: string) =>
    perm === "finance.followup.manage" ? ["u1", "u2"] : [],
  notify: async (_a: unknown, input: Record<string, unknown>) => {
    sent.calls.push(input);
    return { delivered: 0 };
  },
}));

import { parseFollowupRun, runFollowupTasks } from "@/lib/finance/followup-server";
import type { AdminClient } from "@/lib/supabase/admin";

const fake = (data: unknown, error: unknown = null) => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const admin = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push([fn, args]);
      return { data, error };
    },
  } as unknown as AdminClient;
  return { admin, calls };
};
const NOW = new Date("2026-10-26T05:00:00Z");
const TASK = "00000000-0000-4000-8000-0000000000bb";

beforeEach(() => {
  sent.calls = [];
});

describe("runFollowupTasks", () => {
  it("passes the clinic's date and notifies the follow-up people once, with ids and a generic sentence", async () => {
    const { admin, calls } = fake({
      raised: 7,
      tasks: 5,
      superseded: 2,
      unassigned: 0,
      closed: 1,
      first_task_id: TASK,
    });
    const run = await runFollowupTasks(admin, "org", "2026-10-26", NOW);
    expect(calls).toEqual([
      [
        "fin_followup_create_tasks",
        { p_org_id: "org", p_today: "2026-10-26", p_now: NOW.toISOString(), p_limit: 500 },
      ],
    ]);
    expect(run).toEqual({
      skipped: false,
      raised: 7,
      tasks: 5,
      superseded: 2,
      unassigned: 0,
      closed: 1,
    });
    expect(sent.calls).toHaveLength(1);
    const n = sent.calls[0];
    expect(n).toMatchObject({
      orgId: "org",
      userIds: ["u1", "u2"],
      event: "finance.followup_due",
      title: "5 unpaid insurance claims need a follow-up",
      body: "Open Finance, Insurance follow-up to see which.",
      ids: { task_id: TASK },
    });
    expect(n.payload).toEqual({ count: 5 });
  });

  it("says nothing when no task was created (off, or nothing due)", async () => {
    await runFollowupTasks(
      fake({ skipped: "not_enabled", raised: 0, tasks: 0 }).admin,
      "org",
      "2026-10-26",
      NOW,
    );
    await runFollowupTasks(
      fake({ raised: 2, tasks: 0, superseded: 0 }).admin,
      "org",
      "2026-10-26",
      NOW,
    );
    expect(sent.calls).toEqual([]);
  });

  it("throws on a database error without notifying (the job logs the name only)", async () => {
    await expect(
      runFollowupTasks(
        fake(null, { code: "42501", message: "detail" }).admin,
        "org",
        "2026-10-26",
        NOW,
      ),
    ).rejects.toThrow("follow-up step failed");
    expect(sent.calls).toEqual([]);
  });

  it("parses partial results safely", () => {
    expect(parseFollowupRun(null)).toEqual({
      skipped: false,
      raised: 0,
      tasks: 0,
      superseded: 0,
      unassigned: 0,
      closed: 0,
    });
    expect(parseFollowupRun({ skipped: "not_enabled" }).skipped).toBe(true);
  });
});
