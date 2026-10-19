import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * M3 capacity loader over a fake service-role client: branch scoping (Phase B) for hours, rooms and revenue, the
 * revenue link through the doctor's report key (specialists.report_doctor_key), and the "no finance branch code" case. Synthetic data only.
 */

let cookie: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (cookie ? { value: cookie } : undefined) }),
}));

import { loadCapacity, loadCapacityScope } from "@/lib/capacity/server";
import type { AdminClient } from "@/lib/supabase/admin";

const NORTH = "00000000-0000-4000-8000-000000000001";
const SOUTH = "00000000-0000-4000-8000-000000000002";
const EAST = "00000000-0000-4000-8000-000000000003"; // no finance branch code
const ALPHA = "00000000-0000-4000-8000-0000000000a1";
const BETA = "00000000-0000-4000-8000-0000000000b1";

type Row = Record<string, unknown>;
const TABLES: Record<string, Row[]> = {
  locations: [
    { id: EAST, name: "East", timezone: "Asia/Dubai", branch_code: null, active: true },
    { id: NORTH, name: "North", timezone: "Asia/Dubai", branch_code: "NO", active: true },
    { id: SOUTH, name: "South", timezone: "Asia/Dubai", branch_code: "SO", active: true },
  ],
  orgs: [{ id: "org", settings: { appointments: { working_weekdays: [1, 2, 3, 4, 5, 6] } } }],
  fin_ref_finance_settings: [{ org_id: "org", room_open_hours_per_day: 8 }],
  specialists: [
    {
      id: ALPHA,
      org_id: "org",
      name: "Dr Alpha Demo",
      active: true,
      report_doctor_key: "alpha demo",
    },
    { id: BETA, org_id: "org", name: "Dr Beta Demo", active: true, report_doctor_key: null },
  ],
  working_hours: [
    // Alpha: Mondays 09:00-13:00 at North; Beta: Tuesdays 09:00-11:00 at South
    {
      id: "w1",
      org_id: "org",
      specialist_id: ALPHA,
      location_id: NORTH,
      weekday: 1,
      start_min: 540,
      end_min: 780,
    },
    {
      id: "w2",
      org_id: "org",
      specialist_id: BETA,
      location_id: SOUTH,
      weekday: 2,
      start_min: 540,
      end_min: 660,
    },
  ],
  specialist_recurring_blocks: [],
  time_blocks: [],
  rooms: [
    {
      id: "r-north",
      org_id: "org",
      name: "Room N",
      kind: "consultation",
      location_id: NORTH,
      monthly_cost: 1600,
      active: true,
    },
    {
      id: "r-south",
      org_id: "org",
      name: "Room S",
      kind: "dental",
      location_id: SOUTH,
      monthly_cost: null,
      active: true,
    },
  ],
};

const PERF = {
  month: "2026-09-01",
  coverage: [{ from: "2026-09-01", to: "2026-09-30" }],
  current: {
    doctors: [
      { department: "GP", doctor_key: "alpha demo", doctor_name: "ALPHA DEMO", revenue: 1200 },
      { department: "Derm", doctor_key: "alpha demo", doctor_name: "ALPHA DEMO", revenue: 400 },
      { department: "GP", doctor_key: "gamma demo", doctor_name: "GAMMA DEMO", revenue: 900 },
    ],
  },
};

function fakeAdmin() {
  // Like the SQL: the synthetic report rows all belong to the North branch (finance code NO).
  const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => {
    const codes = args.p_branches as string[] | undefined;
    const north = (!codes || codes.includes("NO")) && (!args.p_branch || args.p_branch === "NO");
    return { data: north ? PERF : { ...PERF, current: { doctors: [] } }, error: null };
  });
  const from = (table: string) => {
    let rows = [...(TABLES[table] ?? [])];
    const q = {
      select: () => q,
      eq: (col: string, v: unknown) => {
        rows = rows.filter((r) => !(col in r) || r[col] === v);
        return q;
      },
      in: (col: string, vs: unknown[]) => {
        rows = rows.filter((r) => vs.includes(r[col]));
        return q;
      },
      lt: () => q,
      gt: () => q,
      order: () => q,
      range: () => q,
      single: async () => ({ data: rows[0] ?? null, error: null }),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (ok: (v: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(ok),
    };
    return q;
  };
  return { admin: { from, rpc } as unknown as AdminClient, rpc };
}

const member = (over: Record<string, unknown> = {}) => ({
  orgId: "org",
  branchScope: "all" as const,
  branchIds: [] as string[],
  homeLocationId: null,
  ...over,
});

beforeEach(() => {
  cookie = undefined;
});

describe("capacity loader", () => {
  it("an unrestricted member sees every branch; revenue is unscoped and linked by doctor key", async () => {
    const { admin, rpc } = fakeAdmin();
    const scope = await loadCapacityScope(admin, member(), undefined);
    expect(scope.chosen).toBeNull();
    expect(scope.allowedCodes).toBeNull();
    const cap = await loadCapacity(admin, "org", scope, "2026-09-01");
    expect(rpc).toHaveBeenCalledWith("fin_doctor_performance_inputs", {
      p_org_id: "org",
      p_month: "2026-09-01",
      p_branch: undefined,
      p_branches: undefined,
    });
    const alpha = cap.report.doctors.find((d) => d.specialistId === ALPHA)!;
    // four Mondays in Sep 2026 at 4 h
    expect(alpha.availableHours).toBe(16);
    expect(alpha.revenue).toBe(1600); // both departments
    expect(alpha.revenuePerAvailableHour).toBe(100);
    expect(cap.report.doctors.find((d) => d.specialistId === BETA)!.revenue).toBeNull();
    expect(cap.unlinked).toEqual([
      { doctorKey: "gamma demo", doctorName: "GAMMA DEMO", revenue: 900 },
    ]);
    const north = cap.report.rooms.find((r) => r.id === "r-north")!;
    expect(north.openHours).toBe(26 * 8);
    expect(north.monthlyCost).toBe(1600);
    expect(cap.report.rooms.find((r) => r.id === "r-south")!.monthlyCost).toBeNull();
    expect(cap.report.totals.revenuePerAvailableHour).toBe(100);
    expect(cap.coverage.full).toBe(true);
  });

  it("a member limited to one branch gets that branch's hours, rooms and finance code only", async () => {
    const { admin, rpc } = fakeAdmin();
    const scope = await loadCapacityScope(
      admin,
      member({ branchScope: "selected", branchIds: [SOUTH] }),
      NORTH, // asking for a hidden branch never widens
    );
    expect(scope.locations.map((l) => l.id)).toEqual([SOUTH]);
    expect(scope.chosen).toBeNull();
    expect(scope.scopeIds).toEqual([SOUTH]);
    const cap = await loadCapacity(admin, "org", scope, "2026-09-01");
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_branch: undefined, p_branches: ["SO"] });
    expect(cap.report.rooms.map((r) => r.id)).toEqual(["r-south"]);
    expect(cap.report.doctors.map((d) => d.specialistId)).toEqual([BETA]);
    // the doctor link and working branches in scope, for booked against available (docs/48)
    expect(cap.doctorScope).toEqual({ [BETA]: { doctorKey: null, locationIds: [SOUTH] } });
  });

  it("a branch with no finance code shows hours but no revenue, and never asks for it", async () => {
    const { admin, rpc } = fakeAdmin();
    const scope = await loadCapacityScope(admin, member(), EAST);
    expect(scope.revenueAvailable).toBe(false);
    const cap = await loadCapacity(admin, "org", scope, "2026-09-01");
    expect(rpc).not.toHaveBeenCalled();
    expect(cap.report.totals.revenue).toBeNull();
    expect(cap.report.rooms).toEqual([]);
  });
});
