/**
 * Phase 20I pure rules: configurable ageing buckets, follow-up stages, which stages the daily job may still raise, the
 * open-claim formula, and the receivables matrix and its CSV. Shared synthetic fixture with the SQL parity test
 * (tests/db/finance-followup.test.ts).
 */
import { describe, expect, it } from "vitest";

import {
  ageingBuckets,
  aggregateReceivables,
  bucketIndex,
  crossingDate,
  daysBetween,
  followupRows,
  followupTaskSubject,
  isEvidenced,
  outstandingOf,
  parseDaySteps,
  parseReceivables,
  parseWorklist,
  receivablesCsv,
  receivablesMatrix,
  stageLabel,
  stageReached,
  stagesDue,
  validDaySteps,
  followupFrom,
  type ClaimInput,
  type FollowupAgeBasis,
} from "@/lib/finance/followup";
import { AGEING_BUCKETS } from "@/lib/finance/summary-extras";
import { parseInsuranceOverview } from "@/lib/finance/insurance-overview";

import fixture from "./fixtures/followup.synthetic.json";

const claims = fixture.claims as ClaimInput[];
const opts = {
  today: fixture.today,
  bucketDays: fixture.settings.bucketDays,
  stageDays: fixture.settings.stageDays,
  acceptedStatuses: fixture.settings.acceptedStatuses,
  ageBasis: fixture.settings.ageBasis as FollowupAgeBasis,
};

describe("ageing buckets", () => {
  it("default bounds give 0-30 / 31-60 / 61-90 / 91-120 / 120+", () => {
    expect(ageingBuckets([30, 60, 90, 120]).map((b) => b.label)).toEqual([
      "0-30",
      "31-60",
      "61-90",
      "91-120",
      "120+",
    ]);
  });

  it("other bounds follow the settings, not a hardcoded list", () => {
    expect(ageingBuckets([15, 45]).map((b) => b.label)).toEqual(["0-15", "16-45", "45+"]);
    expect(ageingBuckets([90]).map((b) => b.label)).toEqual(["0-90", "90+"]);
  });

  it("puts each age in the right bucket at the edges", () => {
    const days = [30, 60, 90, 120];
    expect(bucketIndex(0, days)).toBe(0);
    expect(bucketIndex(30, days)).toBe(0);
    expect(bucketIndex(31, days)).toBe(1);
    expect(bucketIndex(60, days)).toBe(1);
    expect(bucketIndex(61, days)).toBe(2);
    expect(bucketIndex(120, days)).toBe(3);
    expect(bucketIndex(121, days)).toBe(4);
    expect(bucketIndex(5000, days)).toBe(4);
    // dated in the future: the first bucket; no date: no bucket (shown on its own, never guessed)
    expect(bucketIndex(-3, days)).toBe(0);
    expect(bucketIndex(null, days)).toBeNull();
  });

  it("validates bucket and stage lists like the SQL check", () => {
    expect(validDaySteps([30, 60, 90, 120], 8)).toBe(true);
    expect(validDaySteps([], 8)).toBe(false);
    expect(validDaySteps([60, 30], 8)).toBe(false);
    expect(validDaySteps([30, 30], 8)).toBe(false);
    expect(validDaySteps([0, 30], 8)).toBe(false);
    expect(validDaySteps([30.5], 8)).toBe(false);
    expect(validDaySteps([1, 2, 3, 4, 5, 6, 7], 6)).toBe(false);
    expect(validDaySteps([3651], 8)).toBe(false);
    expect(parseDaySteps("30, 60; 90 120", 8)).toEqual([30, 60, 90, 120]);
    expect(parseDaySteps("60, 30", 8)).toBeNull();
    expect(parseDaySteps("60, x", 8)).toBeNull();
    expect(parseDaySteps("", 8)).toBeNull();
  });

  it("leaves the existing four-bucket ageing of the summary and the overview untouched", () => {
    expect(AGEING_BUCKETS).toEqual(["0-30", "31-60", "61-90", "90+"]);
    expect(parseInsuranceOverview({}).ageing.map((a) => a.bucket)).toEqual([
      "0-30",
      "31-60",
      "61-90",
      "90+",
    ]);
  });
});

describe("follow-up stages", () => {
  it("reports the highest stage reached", () => {
    const stages = [60, 90, 120];
    expect(stageReached(59, stages)).toBeNull();
    expect(stageReached(60, stages)).toBe(60);
    expect(stageReached(89, stages)).toBe(60);
    expect(stageReached(90, stages)).toBe(90);
    expect(stageReached(400, stages)).toBe(120);
    expect(stageReached(null, stages)).toBeNull();
    expect(stageLabel(null)).toBe("Not yet due");
    expect(stageLabel(90)).toBe("90 days");
  });

  it("counts days in whole calendar days", () => {
    expect(daysBetween("2026-08-27", "2026-10-26")).toBe(60);
    expect(daysBetween(null, "2026-10-26")).toBeNull();
    expect(daysBetween("not a date", "2026-10-26")).toBeNull();
    expect(crossingDate("2026-08-27", 60)).toBe("2026-10-26");
  });

  it("raises nothing until a start date is set, and never a stage crossed before it", () => {
    expect(stagesDue("2026-06-28", [60, 90, 120], null, "2026-10-26")).toEqual([]);
    expect(stagesDue("2026-06-28", [60, 90, 120], "2026-09-26", "2026-10-26")).toEqual([
      { stage: 90, crossedOn: "2026-09-26" },
      { stage: 120, crossedOn: "2026-10-26" },
    ]);
    // a stage that falls after today is not due yet
    expect(stagesDue("2026-10-01", [60], "2026-01-01", "2026-10-26")).toEqual([]);
    expect(stagesDue(null, [60], "2026-01-01", "2026-10-26")).toEqual([]);
  });

  it("matches the fixture's expected stages for the job", () => {
    const due: Record<string, number[]> = {};
    for (const c of claims) {
      if (outstandingOf(c) <= 0) continue;
      const s = stagesDue(
        followupFrom(c, opts.ageBasis),
        opts.stageDays,
        fixture.tasks.startDate,
        opts.today,
      );
      if (s.length) due[c.claimActivityNumber] = s.map((x) => x.stage);
    }
    expect(due).toEqual(fixture.tasks.expectedStages);
  });

  it("the task subject carries the stage only", () => {
    expect(followupTaskSubject(90, "visit")).toBe("Insurance claim follow-up: 90 days unpaid");
    expect(followupTaskSubject(120)).toBe("Insurance claim follow-up: 120 days since submission");
  });
});

describe("open claims", () => {
  it("outstanding is net less remitted less an APPROVED write-off, never negative", () => {
    expect(
      outstandingOf({ net: 800, remitted: 200, writeOff: 100, writeOffStatus: "Approved" }),
    ).toBe(500);
    expect(outstandingOf({ net: 120, remitted: 0, writeOff: 120, writeOffStatus: "Pending" })).toBe(
      120,
    );
    expect(outstandingOf({ net: 100, remitted: 150, writeOff: null, writeOffStatus: null })).toBe(
      0,
    );
    expect(outstandingOf({ net: null, remitted: null, writeOff: null, writeOffStatus: null })).toBe(
      0,
    );
  });

  it("evidence is a remitted amount or a listed status, case-insensitive", () => {
    expect(isEvidenced({ remitted: 1, claimStatus: null }, [])).toBe(true);
    expect(isEvidenced({ remitted: 0, claimStatus: " approved " }, ["Approved"])).toBe(true);
    expect(isEvidenced({ remitted: 0, claimStatus: "Approved" }, [])).toBe(false);
    expect(isEvidenced({ remitted: 0, claimStatus: "" }, [""])).toBe(false);
  });

  it("builds the worklist rows the fixture expects, oldest first, closed claims dropped", () => {
    const rows = followupRows(claims, opts);
    const exp = fixture.expected as Record<string, Record<string, unknown>>;
    const open = Object.entries(exp)
      .filter(([, e]) => e.open)
      .map(([k]) => k);
    expect(rows.map((r) => r.claimActivityNumber).sort()).toEqual(open.sort());
    for (const r of rows) {
      const e = exp[r.claimActivityNumber];
      expect(
        {
          ageDays: r.ageDays,
          bucket: r.bucket,
          stage: r.stage,
          outstanding: r.outstanding,
          evidenced: r.evidenced,
        },
        r.claimActivityNumber,
      ).toEqual({
        ageDays: e.ageDays,
        bucket: e.bucket,
        stage: e.stage,
        outstanding: e.outstanding,
        evidenced: e.evidenced,
      });
    }
    // oldest first, the undated claim last
    expect(rows[0].claimActivityNumber).toBe("CA-SYN-005");
    expect(rows[rows.length - 1].claimActivityNumber).toBe("CA-SYN-007");
  });
});

describe("receivables by payer and age", () => {
  const rows = followupRows(claims, opts);
  const names = new Map(fixture.payers.map((p) => [p.payerId, p.payerName]));
  const aggs = aggregateReceivables(rows).map((a) => ({
    ...a,
    payerName: names.get(a.payerId ?? "") ?? null,
  }));
  const m = receivablesMatrix(aggs, opts.bucketDays);

  it("totals tie to the open claims, by payer and by bucket", () => {
    const total = rows.reduce((n, r) => n + r.outstanding, 0);
    expect(m.totals.outstanding).toBe(Math.round(total * 100) / 100);
    expect(m.totals.claims).toBe(rows.length);
    expect(m.payers.reduce((n, p) => n + p.outstanding, 0)).toBeCloseTo(total, 2);
    for (const p of m.payers) {
      expect(p.cells).toHaveLength(opts.bucketDays.length + 2); // buckets, 120+, no date
      expect(p.cells.reduce((n, c) => n + c.outstanding, 0)).toBeCloseTo(p.outstanding, 2);
    }
    for (let i = 0; i < m.totals.cells.length; i++)
      expect(m.payers.reduce((n, p) => n + p.cells[i].outstanding, 0)).toBeCloseTo(
        m.totals.cells[i].outstanding,
        2,
      );
  });

  it("puts the fixture's claims in the right cells", () => {
    const payerB = m.payers.find((p) => p.payerId === "PAY-B")!;
    expect(payerB.payerName).toBe("Synthetic Payer B");
    expect(payerB.cells.map((c) => c.outstanding)).toEqual([0, 0, 1000, 500, 0, 0]);
    const payerC = m.payers.find((p) => p.payerId === "PAY-C")!;
    expect(payerC.cells[4]).toMatchObject({ claims: 1, outstanding: 250 });
    expect(payerC.cells[5]).toMatchObject({ bucket: null, claims: 1, outstanding: 150 });
    const none = m.payers.find((p) => p.payerId === "(no payer)")!;
    expect(none.cells[2]).toMatchObject({ claims: 1, outstanding: 120 });
    // largest balance first
    expect(m.payers[0].payerId).toBe("PAY-B");
  });

  it("never drops an amount whose bucket is beyond the list", () => {
    const x = receivablesMatrix([{ payerId: "P", bucket: 9, claims: 1, outstanding: 10 }], [30]);
    expect(x.totals.cells.map((c) => c.outstanding)).toEqual([0, 10, 0]);
  });

  it("writes a CSV with every bucket, the totals row and no formulas", () => {
    const csv = receivablesCsv(m, fixture.today);
    const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toContain("0-30 (AED)");
    expect(lines[0]).toContain("120+ (claims)");
    expect(lines[0]).toContain("No date (AED)");
    expect(lines).toHaveLength(m.payers.length + 2);
    expect(lines[lines.length - 1]).toContain("TOTAL");
    expect(lines[lines.length - 1]).toContain(m.totals.outstanding.toFixed(2));
    const hostile = receivablesMatrix(
      [{ payerId: "=HYPERLINK(1)", payerName: "+cmd", bucket: 0, claims: 1, outstanding: 5 }],
      [30],
    );
    const h = receivablesCsv(hostile, fixture.today);
    expect(h).toContain("'=HYPERLINK(1)");
    expect(h).toContain("'+cmd");
  });
});

describe("parsing the SQL results", () => {
  it("tolerates empty input and keeps defaults", () => {
    const w = parseWorklist(null);
    expect(w.rows).toEqual([]);
    expect(w.bucketDays).toEqual([30, 60, 90, 120]);
    expect(w.stageDays).toEqual([120]);
    expect(w.ageBasis).toBe("submission");
    expect(w.tasksEnabled).toBe(false);
    expect(parseReceivables(undefined).aggregates).toEqual([]);
  });

  it("reads a worklist row with its last follow-up and task", () => {
    const w = parseWorklist({
      today: "2026-10-26",
      bucket_days: [30, 60],
      stage_days: [60],
      tasks_from: "2026-10-01",
      tasks_enabled: true,
      total: 1,
      total_outstanding: 10,
      by_stage: [{ stage: 60, claims: 1, outstanding: 10 }],
      payers: [{ payer_id: "PAY-A", payer_name: null }],
      branches: ["P"],
      rows: [
        {
          id: "x",
          claim_activity_number: "CA-1",
          age_days: 61,
          bucket: 2,
          stage: 60,
          outstanding: 10,
          evidenced: true,
          last_followup: { outcome: "made_up", created_at: "2026-10-20T00:00:00Z" },
          task: { stage: 60, task_id: "t", done: false, assignee_id: null },
        },
      ],
    });
    expect(w.tasksEnabled).toBe(true);
    expect(w.rows[0].lastFollowup?.outcome).toBe("other"); // an unknown outcome is never shown as a real one
    expect(w.rows[0].task).toEqual({ stage: 60, taskId: "t", done: false, assigneeId: null });
  });
});

describe("follow-up from the submission date (Insurance, 23 Oct 2026)", () => {
  const sub = { ...opts, ageBasis: "submission" as FollowupAgeBasis };

  it("counts a resubmitted claim from its last resubmission, the others from the visit", () => {
    expect(
      followupFrom(
        { transactionDate: "2026-07-28", lastResubmissionDate: "2026-09-16" },
        "submission",
      ),
    ).toBe("2026-09-16");
    expect(
      followupFrom({ transactionDate: "2026-07-28", lastResubmissionDate: null }, "submission"),
    ).toBe("2026-07-28");
    expect(
      followupFrom({ transactionDate: "2026-07-28", lastResubmissionDate: "2026-09-16" }, "visit"),
    ).toBe("2026-07-28");
    expect(
      followupFrom({ transactionDate: null, lastResubmissionDate: null }, "submission"),
    ).toBeNull();
  });

  it("changes only the stage of the resubmitted claim; ageing buckets still count from the visit", () => {
    const visitRows = followupRows(claims, opts);
    const subRows = followupRows(claims, sub);
    const changed = fixture.submissionBasis.changed as Record<
      string,
      { followupFrom: string; followupAgeDays: number; stage: number | null }
    >;
    for (const r of subRows) {
      const v = visitRows.find((x) => x.id === r.id)!;
      expect(r.ageDays, r.claimActivityNumber).toBe(v.ageDays);
      expect(r.bucket, r.claimActivityNumber).toBe(v.bucket);
      const want = changed[r.claimActivityNumber];
      if (want)
        expect({ from: r.followupFrom, age: r.followupAgeDays, stage: r.stage }).toEqual({
          from: want.followupFrom,
          age: want.followupAgeDays,
          stage: want.stage,
        });
      else expect(r.stage, r.claimActivityNumber).toBe(v.stage);
    }
  });

  it("raises the job's stages from the submission date", () => {
    const due: Record<string, number[]> = {};
    for (const c of claims) {
      if (outstandingOf(c) <= 0) continue;
      const s = stagesDue(
        followupFrom(c, "submission"),
        opts.stageDays,
        fixture.tasks.startDate,
        opts.today,
      );
      if (s.length) due[c.claimActivityNumber] = s.map((x) => x.stage);
    }
    expect(due).toEqual(fixture.submissionBasis.expectedStages);
  });

  it("flags only at 120 days with the new default", () => {
    const rows = followupRows(claims, { ...sub, stageDays: [120] });
    expect(
      rows
        .filter((r) => r.stage === 120)
        .map((r) => r.claimActivityNumber)
        .sort(),
    ).toEqual(["CA-SYN-004", "CA-SYN-005", "CA-SYN-011"]);
  });
});
