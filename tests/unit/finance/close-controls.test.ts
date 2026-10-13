import { describe, expect, it } from "vitest";

import {
  amountText,
  controlSections,
  deriveMatters,
  NOT_CAPTURED,
  NOT_SET_UP,
  readControls,
  type CloseControls,
} from "@/lib/finance/close-controls";
import { buildClosePack, readClosePack, type ClosePackInput } from "@/lib/finance/close-pack";
import { closePackPdf } from "@/lib/finance/close-pdf";
import { closePackXlsx, type SignOff } from "@/lib/finance/close-xlsx";

import fixture from "./fixtures/phase18-close.synthetic.json";

/** A synthetic summary in which every check finds something (Phase 20G part 2). */
const troubled: CloseControls = {
  version: 1,
  month: "2026-09-01",
  month_end: "2026-09-30",
  as_of: "2026-10-14",
  settings: {
    item_max_age_days: 60,
    voucher_unpaid_days: 14,
    receivables_over90_pct: 25,
    inputs_wd: 5,
    revshare_wd: 7,
  },
  bank: {
    accounts: [
      {
        account_id: "acc-1",
        name: "Main",
        last4: "1234",
        status: "reviewed",
        period_end: "2026-09-30",
        expected_unmatched: { count: 3, amount: 350.5 },
        bank_unexplained: { count: 2, amount: 700, oldest_days: 86, over_limit: 1 },
      },
    ],
  },
  payables: {
    invoices_unpaid: { count: 4, amount: 6700 },
    by_age: [
      { bucket: "0-30", count: 1, amount: 1000 },
      { bucket: "31-60", count: 1, amount: 2000 },
      { bucket: "61-90", count: 1, amount: 700 },
      { bucket: "90+", count: 1, amount: 3000 },
    ],
    vouchers_approved_unpaid: {
      count: 2,
      amount: 1750,
      oldest_days: 24,
      over_limit: { count: 1, amount: 1500 },
    },
    vouchers_waiting: {
      submitted: { count: 1, amount: 100 },
      checked: { count: 0, amount: 0 },
      dept_approved: { count: 0, amount: 0 },
      for_tally: { count: 0, amount: 0 },
    },
  },
  revenue_share: {
    run_status: "verified",
    approved_on: null,
    due_on: "2026-10-12",
    liability: {
      total: 800,
      runs: [{ month: "2026-08-01", status: "posted", doctors: 1, unpaid: 800 }],
    },
  },
  invoice_changes: { measured: true, from: "2026-09-10", unapproved: { count: 2, amount: 600 } },
  receivables: {
    open_claims: 2,
    outstanding: 3000,
    over_90: { count: 1, amount: 2000 },
    over_90_pct: 66.7,
  },
  timetable: {
    tasks: 10,
    done: 2,
    blocked: 1,
    inputs_wd: 5,
    inputs_due_on: "2026-10-08",
    inputs: { total: 6, on_time: 1, late: 5, pending: 0 },
  },
  exceptions: { open: 2, oldest_days: 74, over_limit: 1 },
};

/** The same month with everything in order. */
const clean: CloseControls = {
  ...troubled,
  bank: {
    accounts: [
      {
        ...troubled.bank!.accounts[0],
        status: "signed",
        bank_unexplained: { count: 1, amount: 20, oldest_days: 12, over_limit: 0 },
      },
    ],
  },
  payables: {
    ...troubled.payables!,
    vouchers_approved_unpaid: {
      count: 1,
      amount: 250,
      oldest_days: 4,
      over_limit: { count: 0, amount: 0 },
    },
  },
  revenue_share: { ...troubled.revenue_share!, run_status: "posted", approved_on: "2026-10-12" },
  invoice_changes: { measured: true, from: "2026-09-10", unapproved: { count: 0, amount: 0 } },
  receivables: { ...troubled.receivables!, over_90_pct: 25 },
  timetable: {
    ...troubled.timetable!,
    blocked: 0,
    inputs: { total: 6, on_time: 6, late: 0, pending: 0 },
  },
  exceptions: { open: 2, oldest_days: 40, over_limit: 0 },
};

const nothing: CloseControls = {
  ...troubled,
  bank: null,
  payables: null,
  revenue_share: null,
  invoice_changes: { measured: false },
  receivables: null,
  timetable: null,
  exceptions: { open: 0, oldest_days: null, over_limit: 0 },
};

const unsigned: SignOff = {
  financeBy: null,
  financeAt: null,
  financeNote: null,
  ceoBy: null,
  ceoAt: null,
  ceoNote: null,
  lockedAt: null,
  hash: null,
};
const base = fixture as unknown as ClosePackInput;
const oldPack = buildClosePack(base); // a pack built before the control summary existed
const newPack = buildClosePack({ ...base, controls: troubled });

const sheetText = async (buf: Buffer, name: string) => {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  const lines: string[] = [];
  wb.getWorksheet(name)!.eachRow((r) => lines.push(String(r.values)));
  return { wb, text: lines.join("\n") };
};
const pdfText = async (buf: Buffer) => {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const { text } = await extractText(await getDocumentProxy(new Uint8Array(buf)), {
    mergePages: true,
  });
  return Array.isArray(text) ? text.join("\n") : text;
};

describe("deriveMatters", () => {
  it("lists every check that fails, with the figures and the thresholds", () => {
    const m = deriveMatters(troubled);
    expect(m.map((x) => x.key)).toEqual([
      "bank_unsigned:acc-1",
      "bank_old:acc-1",
      "vouchers_unpaid",
      "revshare_unapproved",
      "invoice_changes",
      "receivables_old",
      "inputs_late",
      "steps_blocked",
      "exceptions_old",
    ]);
    const text = m.map((x) => x.text).join("\n");
    expect(text).toContain("Bank reconciliation for Main (ending 1234) is reviewed, not signed.");
    expect(text).toContain("more than 60 days (oldest 86 days)");
    expect(text).toContain("1 approved voucher (AED 1,500.00) not paid within 14 days");
    expect(text).toContain("status verified; due by working day 7, 2026-10-12");
    expect(text).toContain("2 invoice changes without approval in the month (AED 600.00)");
    expect(text).toContain("66.7% of insurance receivables (AED 2,000.00)");
    expect(text).toContain("the limit is 25%");
    expect(text).toContain("5 close inputs due by working day 5 were late or are still missing");
    expect(text).toContain("1 close step blocked");
    expect(text).toContain("1 open finance exception older than 60 days (oldest 74 days)");
  });
  it("finds nothing when everything is in order (a share equal to the limit is within it)", () => {
    expect(deriveMatters(clean)).toEqual([]);
  });
  it("finds nothing for features that are not set up, and never treats them as zero", () => {
    expect(deriveMatters(nothing)).toEqual([]);
    const rows = controlSections(nothing).flatMap((s) => s.rows.map((r) => r[1]));
    expect(rows.filter((v) => v === NOT_SET_UP)).toHaveLength(5);
    expect(rows).toContain("Not measured (no start date set)");
  });
  it("flags a revenue-share run with no run, or approved after the working day", () => {
    const none = { ...troubled.revenue_share!, run_status: "none" as const };
    expect(deriveMatters({ ...clean, revenue_share: none })[0].text).toContain("no run yet");
    const late = { ...clean.revenue_share!, approved_on: "2026-10-13" };
    expect(deriveMatters({ ...clean, revenue_share: late })).toEqual([
      {
        key: "revshare_late",
        text: "The revenue-share run was approved on 2026-10-13, after working day 7, 2026-10-12.",
      },
    ]);
    const noDue = { ...clean.revenue_share!, due_on: null };
    expect(deriveMatters({ ...clean, revenue_share: noDue }).map((x) => x.key)).toEqual([
      "revshare_late",
    ]);
  });
  it("is deterministic", () => {
    expect(JSON.stringify(deriveMatters(troubled))).toBe(JSON.stringify(deriveMatters(troubled)));
  });
});

describe("helpers", () => {
  it("formats amounts without the runtime's locale", () => {
    expect(amountText(0)).toBe("0.00");
    expect(amountText(1234567.5)).toBe("1,234,567.50");
    expect(amountText(-950.456)).toBe("-950.46");
  });
  it("reads only a version 1 summary", () => {
    expect(readControls(troubled)).toBe(troubled);
    expect(readControls(undefined)).toBeNull();
    expect(readControls({ ...troubled, version: 2 })).toBeNull();
    expect(readControls({ version: 1, month: "2026-09-01" })).toBeNull();
  });
});

describe("the pack", () => {
  it("freezes the summary and its matters with the pack", () => {
    expect(newPack.controls).toBe(troubled);
    expect(newPack.matters).toEqual(deriveMatters(troubled));
    expect(readClosePack(JSON.parse(JSON.stringify(newPack)))?.matters).toHaveLength(9);
    expect(JSON.stringify(buildClosePack({ ...base, controls: troubled }))).toBe(
      JSON.stringify(newPack),
    );
  });
  it("leaves a pack built without the summary as it was (old snapshots stay valid)", () => {
    expect("controls" in oldPack).toBe(false);
    expect("matters" in oldPack).toBe(false);
    expect(readClosePack(JSON.parse(JSON.stringify(oldPack)))).not.toBeNull();
  });
  it("writes a Controls sheet with the matters and the sections, values only", async () => {
    const { wb, text } = await sheetText(await closePackXlsx(newPack, unsigned), "Controls");
    expect(wb.worksheets.map((w) => w.name).slice(0, 2)).toEqual(["Summary", "Controls"]);
    expect(text).toContain("Matters needing attention");
    expect(text).toContain("Bank reconciliation for Main (ending 1234) is reviewed, not signed.");
    expect(text).toContain("Payables");
    expect(text).toContain("Supplier invoices unpaid at month end,4, AED 6,700.00");
    expect(text).toContain("Balance sheet: comes from Tally");
    wb.eachSheet((ws) =>
      ws.eachRow((row) =>
        row.eachCell((cell) =>
          expect(
            typeof cell.value === "object" && cell.value && "formula" in (cell.value as object),
          ).toBeFalsy(),
        ),
      ),
    );
  });
  it("renders an old pack with 'not captured in this pack'", async () => {
    const { text } = await sheetText(await closePackXlsx(oldPack, unsigned), "Controls");
    expect(text).toContain(NOT_CAPTURED);
    const pdf = await pdfText(await closePackPdf(oldPack, unsigned));
    expect(pdf).toContain("Not captured in this pack");
  });
  it("puts the matters and the controls in the PDF", async () => {
    const pdf = await pdfText(await closePackPdf(newPack, unsigned));
    expect(pdf).toContain("Matters needing attention");
    expect(pdf).toContain("Bank reconciliation for Main (ending 1234) is reviewed, not signed.");
    expect(pdf).toContain("Doctor revenue share");
    expect(pdf).toContain("Balance sheet: comes from Tally");
  });
});
