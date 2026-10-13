import { describe, expect, it } from "vitest";

import {
  addMonths,
  basisProblem,
  cumulativeThrough,
  depreciationForecast,
  depreciationSchedule,
  disposalFigures,
  lastDepreciationMonth,
  monthEnd,
  monthsBetween,
  runAmount,
  type DepreciationBasis,
} from "@/lib/accounting/assets/depreciation";
import { assetErrorMessage } from "@/lib/accounting/assets/errors";
import { registerAt, scheduleStatus, type RegisterAsset } from "@/lib/accounting/assets/register";
import {
  planDepreciationRun,
  planScheduleRun,
  runPayload,
  runTotal,
  scheduleRunKind,
  type PlanSchedule,
} from "@/lib/accounting/assets/runs";
import {
  scheduleCumulative,
  scheduleMonthAmount,
  scheduleRunAmount,
  scheduleProblem,
} from "@/lib/accounting/assets/schedules";

/** Phase 22H, pure: depreciation schedules, runs, disposals, schedules and the register. Synthetic figures only. */

const sl = (over: Partial<DepreciationBasis> = {}): DepreciationBasis => ({
  cost: 12000,
  residual: 0,
  lifeMonths: 60,
  method: "straight_line",
  inServiceDate: "2026-07-15",
  ...over,
});
const sum = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x * 100, 0)) / 100;

describe("months", () => {
  it("counts and moves whole months", () => {
    expect(monthsBetween("2026-07-31", "2027-06-01")).toBe(11);
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-01");
    expect(addMonths("2026-01-31", -1)).toBe("2025-12-01");
    expect(monthEnd("2028-02-10")).toBe("2028-02-29");
  });
});

describe("straight line", () => {
  it("charges evenly and adds up to cost minus residual exactly", () => {
    const s = depreciationSchedule(sl());
    expect(s).toHaveLength(60);
    expect(new Set(s)).toEqual(new Set([200]));
    const odd = depreciationSchedule(sl({ cost: 1000, lifeMonths: 3 }));
    expect(odd).toEqual([333.33, 333.34, 333.33]);
    expect(sum(odd)).toBe(1000);
  });

  it("uses the full-month convention: the in-service month counts whatever the day", () => {
    expect(cumulativeThrough(sl(), "2026-06-01")).toBe(0);
    expect(cumulativeThrough(sl(), "2026-07-01")).toBe(200);
    expect(cumulativeThrough(sl({ inServiceDate: "2026-07-31" }), "2026-07-01")).toBe(200);
    expect(cumulativeThrough(sl(), "2027-06-30")).toBe(2400);
    expect(lastDepreciationMonth(sl())).toBe("2031-06-01");
  });

  it("stops at the residual value and never goes below it", () => {
    const b = sl({ cost: 10000, residual: 1000, lifeMonths: 36, inServiceDate: "2026-01-01" });
    expect(sum(depreciationSchedule(b))).toBe(9000);
    expect(cumulativeThrough(b, "2028-12-01")).toBe(9000);
    expect(cumulativeThrough(b, "2035-01-01")).toBe(9000);
    expect(runAmount(b, "2035-01-01", 9000)).toBe(0);
  });

  it("catches up a month that was not posted, and never charges a negative amount", () => {
    expect(runAmount(sl(), "2026-09-01", 200)).toBe(400);
    expect(runAmount(sl(), "2026-09-01", 600)).toBe(0);
    expect(runAmount(sl(), "2026-09-01", 900)).toBe(0);
  });
});

describe("reducing balance", () => {
  const rb = sl({
    cost: 10000,
    residual: 1000,
    lifeMonths: 10,
    method: "reducing_balance",
    inServiceDate: "2026-01-01",
  });

  it("declines at twice the straight-line rate, then switches to straight line and lands on the residual", () => {
    const s = depreciationSchedule(rb);
    expect(s.slice(0, 3)).toEqual([2000, 1600, 1280]);
    expect(s[8]).toBe(338.86); // straight line on the remaining months is higher by now
    expect(sum(s)).toBe(9000);
    let nbv = 10000;
    for (const x of s) {
      expect(x).toBeGreaterThan(0);
      nbv = Math.round((nbv - x) * 100) / 100;
      expect(nbv).toBeGreaterThanOrEqual(1000);
    }
    expect(nbv).toBe(1000);
  });

  it("works with no residual too", () => {
    const s = depreciationSchedule({ ...rb, residual: 0, lifeMonths: 36 });
    expect(sum(s)).toBe(10000);
    expect(s[0]).toBeGreaterThan(s[35]);
  });

  it("refuses an impossible basis", () => {
    expect(basisProblem(rb)).toBeNull();
    expect(basisProblem({ ...rb, residual: 10000 })).toMatch(/residual/);
    expect(basisProblem({ ...rb, lifeMonths: 0 })).toMatch(/life/);
    expect(basisProblem({ ...rb, cost: 0 })).toMatch(/cost/);
  });
});

describe("disposal", () => {
  const b = sl({ inServiceDate: "2026-07-01" });

  it("charges up to the month before disposal and books a gain", () => {
    const f = disposalFigures({
      basis: b,
      disposalDate: "2027-01-20",
      postedAccumulated: 1000,
      proceeds: 11000,
    });
    expect(f).toEqual({ accumulated: 1200, catchUp: 200, netBookValue: 10800, gainLoss: 200 });
  });

  it("books a loss when scrapped, and never writes back depreciation already posted", () => {
    expect(
      disposalFigures({
        basis: b,
        disposalDate: "2027-01-20",
        postedAccumulated: 1200,
        proceeds: 0,
      }).gainLoss,
    ).toBe(-10800);
    // January was already run before the disposal was entered: it stays charged
    expect(
      disposalFigures({
        basis: b,
        disposalDate: "2027-01-20",
        postedAccumulated: 1400,
        proceeds: 0,
      }),
    ).toEqual({
      accumulated: 1400,
      catchUp: 0,
      netBookValue: 10600,
      gainLoss: -10600,
    });
  });

  it("disposed in the in-service month: nothing was depreciated", () => {
    const f = disposalFigures({
      basis: b,
      disposalDate: "2026-07-31",
      postedAccumulated: 0,
      proceeds: 12500,
    });
    expect(f).toEqual({ accumulated: 0, catchUp: 0, netBookValue: 12000, gainLoss: 500 });
  });
});

describe("schedules", () => {
  const prepaid = { total: 1200, months: 12, startMonth: "2026-07-01" };

  it("releases evenly and exactly", () => {
    expect(scheduleMonthAmount(prepaid, "2026-07-01")).toBe(100);
    expect(scheduleMonthAmount(prepaid, "2026-06-01")).toBe(0);
    expect(scheduleMonthAmount(prepaid, "2027-07-01")).toBe(0);
    expect(scheduleCumulative(prepaid, "2027-06-01")).toBe(1200);
    const odd = { total: 1000, months: 3, startMonth: "2026-07-01" };
    expect(
      ["2026-07-01", "2026-08-01", "2026-09-01"].map((m) => scheduleMonthAmount(odd, m)),
    ).toEqual([333.33, 333.34, 333.33]);
  });

  it("catches up a missed month in the next run", () => {
    expect(scheduleRunAmount(prepaid, "2026-09-01", 100)).toBe(200);
    expect(scheduleRunAmount(prepaid, "2030-01-01", 1200)).toBe(0);
    expect(scheduleProblem(prepaid)).toBeNull();
    expect(scheduleProblem({ ...prepaid, startMonth: "2026-07-02" })).toMatch(/month/);
  });
});

describe("runs", () => {
  const A = "00000000-0000-4000-8000-00000000000a";
  const B = "00000000-0000-4000-8000-00000000000b";
  const C = "00000000-0000-4000-8000-00000000000c";
  const assets = [
    { id: A, status: "active" as const, ...sl({ inServiceDate: "2026-07-01" }) },
    { id: B, status: "active" as const, ...sl({ inServiceDate: "2026-09-03" }) },
    { id: C, status: "disposed" as const, ...sl({ inServiceDate: "2026-01-01" }) },
  ];

  it("charges the month, catches up, skips assets not yet in service", () => {
    expect(
      planDepreciationRun({
        month: "2026-08-01",
        assets,
        posted: [{ ref: A, month: "2026-07-01", amount: 200 }],
      }),
    ).toEqual([{ ref: A, amount: 200 }]);
    expect(planDepreciationRun({ month: "2026-08-01", assets, posted: [] })).toEqual([
      { ref: A, amount: 400 },
    ]);
  });

  it("charges only what comes after the opening depreciation brought from Tally", () => {
    const old = [
      {
        id: A,
        status: "active" as const,
        openingAccumulated: 7200,
        ...sl({ inServiceDate: "2023-07-01" }),
      },
    ];
    // the schedule says 7,400 by July 2026 (37 months, July 2023 included); 7,200 is already in the books
    expect(planDepreciationRun({ month: "2026-07-01", assets: old, posted: [] })).toEqual([
      { ref: A, amount: 200 },
    ]);
    expect(
      planDepreciationRun({
        month: "2026-07-01",
        assets: [{ ...old[0], openingAccumulated: 7500 }],
        posted: [],
      }),
    ).toEqual([]);
  });

  it("gives a disposed asset nothing new, but keeps what a re-run month already posted for it", () => {
    const posted = [
      { ref: C, month: "2026-08-01", amount: 200 },
      { ref: A, month: "2026-08-01", amount: 400 },
    ];
    expect(planDepreciationRun({ month: "2026-08-01", assets, posted })).toEqual([
      { ref: A, amount: 400 },
      { ref: C, amount: 200 },
    ]);
    expect(planDepreciationRun({ month: "2026-09-01", assets, posted })).toEqual([
      { ref: A, amount: 200 },
      { ref: B, amount: 200 },
    ]);
  });

  it("splits schedules between the ordinary run and the reversing-accrual run", () => {
    const base = { months: 6, startMonth: "2026-07-01", status: "active" as const };
    const schedules: PlanSchedule[] = [
      { ...base, id: A, kind: "prepayment", autoReverse: false, total: 600 },
      { ...base, id: B, kind: "accrual", autoReverse: true, total: 600 },
      {
        ...base,
        id: C,
        kind: "deferred_revenue",
        autoReverse: false,
        total: 600,
        status: "cancelled",
      },
    ];
    expect(scheduleRunKind(schedules[1])).toBe("reversing_accruals");
    expect(
      planScheduleRun({ kind: "schedules", month: "2026-08-01", schedules, posted: [] }),
    ).toEqual([{ ref: A, amount: 200 }]);
    // a reversing accrual never catches up: each month is reversed on the 1st of the next
    expect(
      planScheduleRun({
        kind: "reversing_accruals",
        month: "2026-08-01",
        schedules,
        posted: [{ ref: B, month: "2026-07-01", amount: 100 }],
      }),
    ).toEqual([{ ref: B, amount: 100 }]);
    const lines = [
      { ref: A, amount: 0.1 },
      { ref: B, amount: 0.2 },
    ];
    expect(runTotal(lines)).toBe(0.3);
    expect(runPayload("depreciation", lines)[0]).toEqual({ asset_id: A, amount: 0.1 });
    expect(runPayload("schedules", lines)[1]).toEqual({ schedule_id: B, amount: 0.2 });
  });
});

describe("register and forecast", () => {
  const A = "00000000-0000-4000-8000-0000000000aa";
  const D = "00000000-0000-4000-8000-0000000000dd";
  const row = (over: Partial<RegisterAsset>): RegisterAsset => ({
    id: A,
    code: "FA-00001",
    description: "Synthetic ultrasound unit",
    classId: "c1",
    className: "Medical equipment",
    branchCode: "P",
    acquisitionDate: "2026-07-01",
    inServiceDate: "2026-07-01",
    cost: 12000,
    residual: 0,
    status: "active",
    disposalDate: null,
    ...over,
  });
  const posted = [
    { ref: A, month: "2026-07-01", amount: 200 },
    { ref: A, month: "2026-08-01", amount: 200 },
  ];

  it("adds the opening depreciation to the register", () => {
    expect(
      registerAt([row({ openingAccumulated: 1000 })], posted, "2026-08-31").lines[0],
    ).toMatchObject({
      accumulated: 1400,
      nbv: 10600,
    });
  });

  it("shows the books at a date: a month's run counts from its last day", () => {
    const mid = registerAt([row({})], posted, "2026-08-15");
    expect(mid.lines[0]).toMatchObject({ accumulated: 200, nbv: 11800 });
    const end = registerAt([row({})], posted, "2026-08-31");
    expect(end.total).toMatchObject({ count: 1, cost: 12000, accumulated: 400, nbv: 11600 });
    expect(end.byClass[0]).toMatchObject({ label: "Medical equipment", count: 1 });
    expect(end.byBranch[0]).toMatchObject({ label: "P" });
  });

  it("leaves out assets not yet acquired and those disposed on or before the date", () => {
    const assets = [
      row({}),
      row({ id: D, code: "FA-00002", status: "disposed", disposalDate: "2026-08-10" }),
      row({
        id: "x",
        code: "FA-00003",
        acquisitionDate: "2026-09-01",
        inServiceDate: "2026-09-01",
      }),
    ];
    expect(registerAt(assets, posted, "2026-08-31").lines.map((l) => l.code)).toEqual(["FA-00001"]);
    expect(registerAt(assets, posted, "2026-08-09").lines.map((l) => l.code)).toEqual([
      "FA-00001",
      "FA-00002",
    ]);
  });

  it("forecasts 12 months, catching up in the first", () => {
    const f = depreciationForecast(
      [{ ...sl({ inServiceDate: "2026-07-01" }), postedAccumulated: 200 }],
      "2026-09-01",
      12,
    );
    expect(f).toHaveLength(12);
    expect(f[0]).toEqual({ month: "2026-09-01", amount: 400 });
    expect(f[1]).toEqual({ month: "2026-10-01", amount: 200 });
  });

  it("reports what each schedule released and what remains", () => {
    const rows = scheduleStatus(
      [
        {
          id: A,
          kind: "prepayment",
          description: "Synthetic insurance premium",
          total: 1200,
          months: 12,
          startMonth: "2026-07-01",
          autoReverse: false,
          status: "active",
          branchCode: null,
        },
      ],
      posted,
    );
    expect(rows[0]).toMatchObject({
      released: 400,
      remaining: 800,
      lastMonth: "2027-06-01",
      monthsPosted: 2,
    });
  });
});

describe("errors", () => {
  it("turns a hint into a sentence and falls back to the ledger's sentences", () => {
    expect(assetErrorMessage({ hint: "later_month_posted" }, "x")).toMatch(/later month/);
    expect(assetErrorMessage({ hint: "period_locked" }, "x")).toMatch(/locked/);
    expect(assetErrorMessage({ hint: "nope" }, "fallback")).toBe("fallback");
  });
});
