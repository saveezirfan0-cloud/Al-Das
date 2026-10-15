/**
 * M1 management alerts runner: claims before it notifies, notifies once per rule until the alert clears, sends only
 * counts and a month (push and e-mail take the catalogue's fixed sentence), picks recipients by permission (the band
 * alert only to members who see every branch), and leaves a rule alone when its inputs cannot be read. Synthetic data;
 * an in-memory stand-in for the service-role client with the claim semantics of fin_mgmt_alert_claim.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const notifyCalls: Array<Record<string, unknown>> = [];
vi.mock("@/lib/notify/dispatch-db", () => ({
  notify: vi.fn(async (_admin: unknown, input: Record<string, unknown>) => {
    notifyCalls.push(input);
    return { in_app: 1, email: 0, push: 0, recipients: (input.userIds as string[]).length };
  }),
  memberIdsWithPermission: vi.fn(async (_a: unknown, _o: string, perm: string) =>
    perm === "finance.revenue.view" ? ["u-all", "u-branch"] : [`u-${perm}`],
  ),
}));

import { runManagementAlerts } from "@/lib/finance/management-alerts-server";
import type { AdminClient } from "@/lib/supabase/admin";

type State = { rule: string; scope: string; period: string; cleared_at: string | null };

function fakeAdmin(world: {
  lastCovered: string | null;
  coverage: { from: string; to: string }[];
  rows: { date: string; branch: string; department: string; net: number }[];
  dailyTarget: number | null;
  perf?: unknown;
  inputsFail?: boolean;
}) {
  const state: State[] = [];
  const rpc = vi.fn(async (name: string, args: Record<string, string>) => {
    if (name === "fin_mgmt_alert_inputs")
      return world.inputsFail
        ? { data: null, error: { message: "boom" } }
        : {
            data: {
              month: args.p_month,
              last_covered: world.lastCovered,
              coverage: world.coverage,
              rows: world.rows,
            },
            error: null,
          };
    if (name === "fin_doctor_performance_inputs") return { data: world.perf ?? {}, error: null };
    if (name === "fin_mgmt_alert_claim") {
      const s = state.find(
        (x) => x.rule === args.p_rule && x.scope === args.p_scope && x.period === args.p_period,
      );
      if (!s) {
        state.push({
          rule: args.p_rule,
          scope: args.p_scope,
          period: args.p_period,
          cleared_at: null,
        });
        return { data: true, error: null };
      }
      if (s.cleared_at === null) return { data: false, error: null };
      s.cleared_at = null;
      return { data: true, error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  });
  const from = (table: string) => {
    const eq: Record<string, unknown> = {};
    let update: Record<string, unknown> | null = null;
    const result = () => {
      if (table === "fin_ref_finance_settings") return { data: null, error: null };
      if (table === "fin_ref_report_lines") return { data: [], error: null };
      if (table === "fin_ref_revenue_targets")
        return {
          data: world.dailyTarget
            ? [
                {
                  month: eq.month,
                  line_code: null,
                  daily_revenue: world.dailyTarget,
                  daily_patients: null,
                  arpp: null,
                },
              ]
            : [],
          error: null,
        };
      if (table === "memberships") return { data: [{ user_id: "u-all" }], error: null }; // u-branch has branch_scope 'selected'
      if (table === "fin_mgmt_alert_state") {
        const match = state.filter(
          (s) =>
            s.cleared_at === null &&
            Object.entries(eq).every(
              ([k, v]) => k === "org_id" || (s as Record<string, unknown>)[k] === v,
            ),
        );
        if (update) for (const s of match) s.cleared_at = update.cleared_at as string;
        return {
          data: match.map((s) => ({ rule: s.rule, scope: s.scope, period: s.period })),
          error: null,
        };
      }
      throw new Error(`unexpected table ${table}`);
    };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (k: string, v: unknown) => ((eq[k] = v), q),
      is: () => q,
      in: () => q,
      order: () => q,
      update: (u: Record<string, unknown>) => ((update = u), q),
      maybeSingle: async () => result(),
      then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(ok, ko),
    };
    return q;
  };
  return { admin: { from, rpc } as unknown as AdminClient, state };
}

const ORG = { id: "00000000-0000-4000-8000-0000000000aa", timezone: "Asia/Dubai" };
const NOW = new Date("2026-10-14T04:00:00Z"); // 08:00 in Dubai, 14 October
const oct = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;

const fullSeptember = (patients: number) => ({
  month: "2026-09-01",
  previous_month: "2026-08-01",
  coverage: [{ from: "2026-09-01", to: "2026-09-30" }],
  previous_coverage: [],
  settings: { target: 750, near: 700, moderate: 650 },
  current: {
    doctors: [
      {
        department: "Derma",
        doctor_key: "dr demo 01",
        doctor_name: "Dr Demo-01",
        revenue: 100 * patients,
        visits: patients,
        patients,
      },
      {
        department: "Derma",
        doctor_key: "dr demo 02",
        doctor_name: "Dr Demo-02",
        revenue: 800 * patients,
        visits: patients,
        patients,
      },
    ],
    departments: [],
    total: { revenue: 900 * patients, visits: patients, patients },
  },
  previous: {},
});

beforeEach(() => {
  notifyCalls.length = 0;
});

describe("runManagementAlerts", () => {
  it("raises, claims and notifies once; a second run is quiet; recovery clears and a relapse raises again", async () => {
    const world = {
      lastCovered: oct(5), // nothing for 11 to 13 October: late
      coverage: [{ from: oct(1), to: oct(5) }],
      rows: [1, 2, 3, 4, 5].map((d) => ({
        date: oct(d),
        branch: "BA",
        department: "Derma",
        net: 500,
      })),
      dailyTarget: 1000,
      perf: fullSeptember(12),
    };
    const { admin, state } = fakeAdmin(world);

    const first = await runManagementAlerts(admin, ORG, NOW);
    expect(first).toEqual({ raised: 3, cleared: 0, notified: 3, failed: 0 });
    expect(notifyCalls.map((n) => n.event)).toEqual([
      "finance.report_late",
      "finance.revenue_behind",
      "finance.band_below",
    ]);
    expect(notifyCalls[0].userIds).toEqual(["u-finance.revenue.import"]);
    expect(notifyCalls[1].userIds).toEqual(["u-finance.flash.view"]);
    expect(notifyCalls[2].userIds).toEqual(["u-all"]); // the branch-restricted member is left out
    expect(notifyCalls[2].payload).toEqual({ rule: "band_below", count: 1, month: "2026-09" });
    expect(notifyCalls[2].body).toBe(
      "1 doctor was below the revenue-per-patient band in September 2026.",
    );
    for (const n of notifyCalls) {
      expect(n.ids).toBeUndefined(); // push and e-mail: the fixed sentence and the page link only
      expect(JSON.stringify(n)).not.toMatch(/Dr Demo|dr demo|500|1000|AED/);
    }

    notifyCalls.length = 0;
    expect(await runManagementAlerts(admin, ORG, NOW)).toEqual({
      raised: 0,
      cleared: 0,
      notified: 0,
      failed: 0,
    });
    expect(notifyCalls).toEqual([]);

    // The report arrives and revenue recovers: both clear; the band alert stays (one per month).
    world.lastCovered = oct(13);
    world.coverage = [{ from: oct(1), to: oct(13) }];
    world.rows = [...world.rows, { date: oct(6), branch: "BA", department: "Derma", net: 20_000 }];
    const cleared = await runManagementAlerts(admin, ORG, NOW);
    expect(cleared).toEqual({ raised: 0, cleared: 2, notified: 0, failed: 0 });
    expect(state.filter((s) => s.cleared_at === null).map((s) => s.rule)).toEqual(["band_below"]);

    // Late again a few days on: raised again, once.
    world.lastCovered = oct(13);
    const later = new Date("2026-10-20T04:00:00Z");
    const again = await runManagementAlerts(admin, ORG, later);
    expect(again.raised).toBe(1);
    expect(notifyCalls.map((n) => n.event)).toEqual(["finance.report_late"]);
  });

  it("stays silent with no target, no upload ever and a partly covered month", async () => {
    const { admin } = fakeAdmin({
      lastCovered: null,
      coverage: [],
      rows: [],
      dailyTarget: null,
      perf: { ...fullSeptember(12), coverage: [{ from: "2026-09-01", to: "2026-09-20" }] },
    });
    expect(await runManagementAlerts(admin, ORG, NOW)).toEqual({
      raised: 0,
      cleared: 0,
      notified: 0,
      failed: 0,
    });
    expect(notifyCalls).toEqual([]);
  });

  it("leaves a rule's open alerts alone when its inputs cannot be read", async () => {
    const world = {
      lastCovered: oct(1),
      coverage: [{ from: oct(1), to: oct(1) }],
      rows: [],
      dailyTarget: null,
      perf: fullSeptember(5), // under the 10-patient minimum: no band alert
      inputsFail: false,
    };
    const { admin, state } = fakeAdmin(world);
    await runManagementAlerts(admin, ORG, NOW);
    expect(state.map((s) => s.rule)).toEqual(["report_late"]);
    world.inputsFail = true;
    const r = await runManagementAlerts(admin, ORG, NOW);
    expect(r).toEqual({ raised: 0, cleared: 0, notified: 0, failed: 1 });
    expect(state[0].cleared_at).toBeNull();
  });
});
