import { describe, expect, it } from "vitest";

import { tablesWorkbook } from "@/lib/export/table-xlsx";
import { buildClosePack, type ClosePackInput } from "@/lib/finance/close-pack";
import {
  buildGroupPack,
  NOT_IN_PULSE,
  repeatVisits,
  statusLabel,
  type GroupPackInput,
} from "@/lib/finance/group-pack";

import fixture from "./fixtures/phase18-close.synthetic.json";

/** docs/51: Al Das's group-pack submission (pure builder and the workbook). Synthetic figures only. */

const pack = buildClosePack(fixture as unknown as ClosePackInput);
const zero = { revenue: 0, visits: 0, patients: 0, unbilledPatients: 0, newVisits: 0 };

const base = (over: Partial<GroupPackInput> = {}): GroupPackInput => ({
  org: "Synthetic Clinic",
  month: "2026-09-01",
  builtAt: "2026-10-21T06:00:00.000Z",
  status: "built",
  branches: [
    {
      code: "G",
      name: "Golden Mile",
      revenue: 1000,
      visits: 10,
      patients: 8,
      unbilledPatients: 0,
      newVisits: 2,
      cancelledVisits: 1,
    },
    {
      code: "M",
      name: "Meadows",
      revenue: 2000,
      visits: 20,
      patients: 15,
      unbilledPatients: 1,
      newVisits: 4,
      cancelledVisits: 0,
    },
    {
      code: "S",
      name: "Shoreline",
      revenue: 6000.5,
      visits: 50,
      patients: 40,
      unbilledPatients: 2,
      newVisits: 9,
      cancelledVisits: 2,
    },
  ],
  clinic: {
    revenue: 9100.5,
    visits: 82,
    patients: 60,
    unbilledPatients: 3,
    newVisits: 15,
    cancelledVisits: 3,
    previous: { ...zero, revenue: 8000, visits: 70, patients: 55 },
    arppTarget: 750,
    coverage: { label: "1 to 30 Sep 2026", full: true },
  },
  targets: { revenue: 12000, patients: null },
  close: { pack, frozen: true },
  pl: {
    month: {
      direct_income: 9000,
      direct_expense: 3000,
      gross_profit: 6000,
      indirect_income: 100,
      indirect_expense: 2500,
      net_profit: 3600,
    },
    ytd: {
      direct_income: 27000,
      direct_expense: 9000,
      gross_profit: 18000,
      indirect_income: 300,
      indirect_expense: 7500,
      net_profit: 10800,
    },
    ytdFrom: "2026-07-01",
    provisional: true,
    empty: false,
  },
  payables: { missing: "Needs a payables permission (finance.payables.view)." },
  tasks: [
    {
      step: "REVENUE_UNITE",
      title: "Revenue reconciled to Unite",
      owner: "Revenue and receivables",
      dueWd: 5,
      status: "done",
      doneAt: "2026-10-06T08:00:00Z",
      blockedReason: null,
    },
    {
      step: "DRAFT_ACCOUNTS",
      title: "Draft management accounts",
      owner: "Finance Manager",
      dueWd: 8,
      status: "blocked",
      doneAt: null,
      blockedReason: "Waiting for the lab invoice",
    },
  ],
  sign: { financeBy: null, financeAt: null, ceoBy: null, ceoAt: null, lockedAt: null, hash: null },
  ...over,
});

const sheet = (sheets: ReturnType<typeof buildGroupPack>, name: string) => {
  const s = sheets.find((x) => x.sheet === name);
  if (!s) throw new Error(`no sheet ${name}`);
  return s;
};
const row = (sheets: ReturnType<typeof buildGroupPack>, name: string, label: string) => {
  const r = sheet(sheets, name).rows.find((x) => x[0] === label);
  if (!r) throw new Error(`no row ${label} in ${name}`);
  return r;
};

describe("buildGroupPack", () => {
  it("has the Al Das tabs of the group pack, in order", () => {
    expect(buildGroupPack(base()).map((s) => s.sheet)).toEqual([
      "Read Me",
      "Entity P&L",
      "KPI Scorecard",
      "Clinic Branch Source Data",
      "Receivables ageing",
      "Payables ageing",
      "Close & Sign-off",
      "Definitions",
    ]);
  });

  it("puts every branch, Shoreline included, beside the clinic total and what is not assigned", () => {
    const s = buildGroupPack(base());
    expect(sheet(s, "Clinic Branch Source Data").columns.map((c) => c.header)).toEqual([
      "Metric",
      "Golden Mile",
      "Meadows",
      "Shoreline",
      "Not assigned to a branch",
      "Al Das total",
      "Source / note",
    ]);
    // revenue adds up: the rest is what Unite could not place in a branch
    expect(row(s, "Clinic Branch Source Data", "Revenue, AED").slice(1, 6)).toEqual([
      1000, 2000, 6000.5, 100, 9100.5,
    ]);
    // patients are counted once in the total, so branches do not add up and nothing is "not assigned"
    expect(row(s, "Clinic Branch Source Data", "Patients (distinct)").slice(1, 6)).toEqual([
      8,
      15,
      40,
      null,
      60,
    ]);
  });

  it("assigns close-pack figures by branch code and keeps unknown codes apart", () => {
    const s = buildGroupPack(base());
    // fixture branches are G, M and P; P is not one of the finance branches given
    const claimed = row(s, "Clinic Branch Source Data", "Insurance claims submitted, AED");
    const g = pack.by_branch.find((b) => b.branch === "G")!.claimed;
    const m = pack.by_branch.find((b) => b.branch === "M")!.claimed;
    const p = pack.by_branch.find((b) => b.branch === "P")!.claimed;
    expect(claimed.slice(1, 6)).toEqual([g, m, 0, p, pack.totals.claimed]);
  });

  it("leaves what Pulse does not have blank with the reason, never zero", () => {
    const s = buildGroupPack(base());
    const payroll = row(s, "Clinic Branch Source Data", "Payroll cost, AED");
    expect(payroll.slice(1, 6)).toEqual([null, null, null, null, null]);
    expect(payroll[6]).toBe(NOT_IN_PULSE.payroll);
    expect(row(s, "KPI Scorecard", "Payroll as % of revenue").slice(1, 5)).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(sheet(s, "Payables ageing").rows).toEqual([]);
    expect(sheet(s, "Payables ageing").lines).toContain(
      "Needs a payables permission (finance.payables.view).",
    );
  });

  it("scores KPIs against the targets, and repeat visits as visits − patients", () => {
    const s = buildGroupPack(base());
    expect(row(s, "KPI Scorecard", "Revenue, AED").slice(1, 5)).toEqual([
      9100.5, 12000, -2899.5, 8000,
    ]);
    expect(row(s, "KPI Scorecard", "Revenue per patient, AED").slice(1, 4)).toEqual([
      // 60 patients, 3 unbilled: 9100.5 / 57 paid patients (OQ-138)
      159.66, 750, -590.34,
    ]);
    expect(row(s, "KPI Scorecard", "Repeat visits (visits − patients)")[1]).toBe(22);
    expect(repeatVisits({ visits: 3, patients: 5 })).toBe(0);
    expect(row(s, "KPI Scorecard", "Aged insurer receivables over 90 days, AED")[1]).toBe(2100);
  });

  it("gives the receivables ageing in the pack's four buckets, a missing bucket as 0", () => {
    const r = sheet(buildGroupPack(base()), "Receivables ageing");
    expect(r.rows).toEqual([
      ["0-30", 100, 3000],
      ["31-60", 40, 2000],
      ["61-90", 0, 0],
      ["90+", 10, 2100],
    ]);
    expect(r.totals).toEqual(["Total", 150, 7100]);
  });

  it("writes the ledger P&L with Unite revenue beside it, or why it is missing", () => {
    const s = buildGroupPack(base());
    expect(row(s, "Entity P&L", "Gross margin %").slice(1, 3)).toEqual([66.7, 66.7]);
    expect(row(s, "Entity P&L", "Operating expenses, net of other income").slice(1, 3)).toEqual([
      2400, 7200,
    ]);
    expect(row(s, "Entity P&L", "Memo: Unite revenue − ledger revenue")[1]).toBe(100.5);
    const none = buildGroupPack(
      base({
        pl: { missing: "Needs the Accounting reports permission (accounting.reports.view)." },
      }),
    );
    expect(sheet(none, "Entity P&L").rows).toEqual([
      [
        "Profit and loss",
        null,
        null,
        "Needs the Accounting reports permission (accounting.reports.view).",
      ],
    ]);
  });

  it("says provisional until the CEO lock", () => {
    expect(statusLabel("open", null)).toMatch(/^Provisional/);
    expect(statusLabel("finance_signed", null)).toMatch(/waiting for the CEO/);
    expect(
      statusLabel("locked", {
        financeBy: "F",
        financeAt: null,
        ceoBy: "C",
        ceoAt: null,
        lockedAt: "2026-10-09T10:00:00Z",
        hash: null,
      }),
    ).toBe("Locked: signed by Finance and the CEO (2026-10-09).");
  });

  it("handles a month with no Unite report and no close figures", () => {
    const s = buildGroupPack(base({ clinic: null, close: null }));
    expect(row(s, "KPI Scorecard", "Revenue, patients and visits")[5]).toMatch(
      /No Unite report rows/,
    );
    expect(row(s, "Clinic Branch Source Data", "Revenue, AED").slice(1, 6)).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(sheet(s, "Receivables ageing").rows).toEqual([]);
  });

  it("lists the close checklist with blocked reasons", () => {
    expect(sheet(buildGroupPack(base()), "Close & Sign-off").rows).toEqual([
      [
        "REVENUE_UNITE",
        "Revenue reconciled to Unite",
        "Revenue and receivables",
        5,
        "Done",
        "2026-10-06",
        null,
      ],
      [
        "DRAFT_ACCOUNTS",
        "Draft management accounts",
        "Finance Manager",
        8,
        "Blocked",
        null,
        "Waiting for the lab invoice",
      ],
    ]);
  });

  it("renders a workbook with plain values only and no patient fields", async () => {
    const sheets = buildGroupPack(base());
    const buf = await tablesWorkbook({
      org: "Synthetic Clinic",
      builtAt: "2026-10-21T06:00:00.000Z",
      sheets,
    });
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(sheets.map((s) => s.sheet));
    let formulas = 0;
    const text: string[] = [];
    for (const ws of wb.worksheets)
      ws.eachRow((r) =>
        r.eachCell((c) => {
          if (c.formula || (c.value && typeof c.value === "object" && "formula" in c.value))
            formulas++;
          if (typeof c.value === "string") text.push(c.value);
        }),
      );
    expect(formulas).toBe(0);
    expect(text.join(" ")).not.toMatch(/\bPIN\b|emirates|member id|date of birth|phone/i);
  });
});
