/**
 * docs/48: the insurance receivable control (Diligence beside Tally at the month end). The shared synthetic cases are
 * also run against the SQL twin in tests/db/finance-ins-receivable-control.test.ts.
 */
import { describe, expect, it } from "vitest";

import {
  controlSections,
  deriveMatters,
  insReceivableSection,
  type CloseControls,
} from "@/lib/finance/close-controls";
import {
  compareInsuranceReceivable,
  explanationState,
  readInsReceivable,
  recompute,
  snapshotStatus,
  type ControlInput,
  type InsReceivableBlock,
} from "@/lib/finance/insurance-receivable-control";
import { buildClosePack, type ClosePackInput } from "@/lib/finance/close-pack";
import { closePackPdf } from "@/lib/finance/close-pdf";
import { closePackXlsx, insNoteText, type SignOff } from "@/lib/finance/close-xlsx";

import fixture from "./fixtures/ins-receivable-control.synthetic.json";
import closeFixture from "./fixtures/phase18-close.synthetic.json";

type Case = {
  name: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown> & { payers: unknown[] };
};

describe("compareInsuranceReceivable (shared cases)", () => {
  for (const c of fixture.cases as Case[]) {
    it(c.name, () => {
      const r = compareInsuranceReceivable(c.input as unknown as ControlInput);
      expect(r.status).toBe(c.expected.status);
      expect(r.basis).toBe(c.expected.basis);
      expect(r.diligence_total).toBe(c.expected.diligence_total);
      expect(r.tally_total).toBe(c.expected.tally_total);
      expect(r.difference).toBe(c.expected.difference);
      expect(r.payers).toEqual(c.expected.payers);
    });
  }

  it("covers each status and basis the rule can give", () => {
    const seen = new Set((fixture.cases as Case[]).map((c) => `${c.expected.status}`));
    for (const s of ["agrees", "differs", "no_tally_data", "no_diligence_data"])
      expect(seen.has(s)).toBe(true);
    const bases = new Set((fixture.cases as Case[]).map((c) => `${c.expected.basis}`));
    for (const b of ["per_payer", "total", "none"]) expect(bases.has(b)).toBe(true);
  });
});

describe("compareInsuranceReceivable (edges)", () => {
  const base: ControlInput = {
    tolerance: 1,
    tally_state: "mirrored",
    diligence: [{ payer_id: null, amount: 100 }],
    tally: [{ payer_id: null, amount: 100 }],
  };

  it("a tolerance that is not a number counts as zero", () => {
    const r = compareInsuranceReceivable({
      ...base,
      tolerance: Number.NaN,
      tally: [{ payer_id: null, amount: 100.01 }],
    });
    expect(r.status).toBe("differs");
  });

  it("a list that is not a list, or a row that is not an object, fails closed", () => {
    expect(
      compareInsuranceReceivable({ ...base, diligence: {} as unknown as ControlInput["diligence"] })
        .status,
    ).toBe("differs");
    expect(
      compareInsuranceReceivable({ ...base, tally: [5] as unknown as ControlInput["tally"] })
        .status,
    ).toBe("differs");
    expect(
      compareInsuranceReceivable({ ...base, tally: [{ payer_id: null, amount: Infinity }] }).status,
    ).toBe("differs");
  });

  it("an unreadable Diligence list fails closed even when Tally has no data", () => {
    expect(
      compareInsuranceReceivable({
        ...base,
        tally_state: "no_data",
        diligence: [{ payer_id: null, amount: "x" }] as unknown as ControlInput["diligence"],
      }).status,
    ).toBe("differs");
  });

  it("a Tally list that is null while mirrored counts as zero", () => {
    const r = compareInsuranceReceivable({ ...base, tally: null });
    expect(r.tally_total).toBe(0);
    expect(r.status).toBe("differs");
  });
});

const block = (over: Partial<InsReceivableBlock> = {}): InsReceivableBlock => {
  const b: InsReceivableBlock = {
    version: 1,
    month_end: "2026-09-30",
    tolerance: 1,
    tally_state: "mirrored",
    accounts: [{ code: "1200", name: "Insurance receivable", payer_id: null }],
    diligence: [
      { payer_id: "INS-A", amount: 500, claims: 3 },
      { payer_id: "INS-B", amount: 300, claims: 1 },
    ],
    tally: [{ payer_id: null, amount: 820 }],
    tally_last_mirrored_at: "2026-10-03T06:15:00+00:00",
    tally_last_voucher_date: "2026-10-02",
    remitted_after: { claims: 2, amount: 40 },
    remitted_straddling: 1,
    payer_names: { "INS-A": "Synthetic Health" },
    result: {} as InsReceivableBlock["result"],
    ...over,
  };
  b.result = recompute(b);
  return b;
};

const controlsWith = (ins: unknown): CloseControls =>
  ({
    version: 1,
    month: "2026-09-01",
    month_end: "2026-09-30",
    as_of: "2026-10-05",
    settings: {
      item_max_age_days: 60,
      voucher_unpaid_days: 14,
      receivables_over90_pct: 25,
      inputs_wd: 5,
      revshare_wd: 7,
    },
    bank: null,
    payables: null,
    revenue_share: null,
    invoice_changes: { measured: false },
    receivables: null,
    timetable: null,
    exceptions: { open: 0, oldest_days: null, over_limit: 0 },
    ...(ins === undefined ? {} : { ins_receivable: ins }),
  }) as CloseControls;

describe("the frozen block", () => {
  it("reads a version 1 block and refuses anything else", () => {
    expect(readInsReceivable(block())).not.toBeNull();
    expect(readInsReceivable({ ...block(), version: 2 })).toBeNull();
    expect(readInsReceivable(null)).toBeNull();
    expect(readInsReceivable("x")).toBeNull();
  });

  it("the status is recomputed from the inputs, never taken from the stored result", () => {
    const b = block();
    expect(snapshotStatus(controlsWith(b))).toBe("differs");
    const lying = { ...b, result: { ...b.result, status: "agrees" } };
    expect(snapshotStatus(controlsWith(lying))).toBe("differs");
  });

  it("no block = no requirement (packs built before the control); a broken block fails closed", () => {
    expect(snapshotStatus(controlsWith(undefined))).toBeNull();
    expect(snapshotStatus(controlsWith(null))).toBeNull();
    expect(snapshotStatus(null)).toBeNull();
    expect(snapshotStatus(controlsWith("broken"))).toBe("differs");
    expect(snapshotStatus(controlsWith({ tally_state: "started" }))).toBe("differs");
  });

  it("explanationState: only a difference needs one, and only one for this build counts", () => {
    expect(explanationState("agrees", null, "h1")).toBe("not_needed");
    expect(explanationState("no_tally_data", null, "h1")).toBe("not_needed");
    expect(explanationState("differs", null, "h1")).toBe("missing");
    expect(explanationState("differs", { hash: "h0" }, "h1")).toBe("stale");
    expect(explanationState("differs", { hash: "h1" }, "h1")).toBe("given");
  });
});

describe("close pack rendering", () => {
  it("a difference becomes a matter with the figures and the tolerance", () => {
    const m = deriveMatters(controlsWith(block()));
    const hit = m.find((x) => x.key === "ins_receivable_differs");
    expect(hit?.text).toContain(
      "Tally (AED 820.00) differs from Diligence (AED 800.00) by AED 20.00",
    );
    expect(hit?.text).toContain("tolerance is AED 1.00");
  });

  it("no matter when it agrees, or when there is no Tally data", () => {
    const agrees = block({ tally: [{ payer_id: null, amount: 800.5 }] });
    expect(
      deriveMatters(controlsWith(agrees)).some((x) => x.key === "ins_receivable_differs"),
    ).toBe(false);
    const none = block({ tally_state: "no_account", tally: null });
    expect(deriveMatters(controlsWith(none)).some((x) => x.key === "ins_receivable_differs")).toBe(
      false,
    );
  });

  it("the section says Tally, the basis, the freshness and the remittance adjustments", () => {
    const rows = Object.fromEntries(insReceivableSection(controlsWith(block())).rows);
    expect(rows.Status).toBe("Differs");
    expect(rows["Tally insurer receivable at 2026-09-30"]).toBe("AED 820.00");
    expect(rows["Diligence receivable at 2026-09-30"]).toBe("AED 800.00");
    expect(rows["Difference (Tally minus Diligence)"]).toBe("AED 20.00");
    expect(rows.Compared).toMatch(/^in total/);
    expect(rows["Tally ledger(s)"]).toBe("1200 Insurance receivable");
    expect(rows["Tally figures as fresh as"]).toContain("2026-10-03 06:15");
    expect(rows["Remitted after the month end, added back"]).toBe("2 claims, AED 40.00");
  });

  it("per payer rows carry the payer name when reference data has one", () => {
    const b = block({
      tally: [
        { payer_id: "INS-A", amount: 500 },
        { payer_id: "INS-B", amount: 310 },
      ],
    });
    const sec = insReceivableSection(controlsWith(b));
    const labels = sec.rows.map(([k]) => k);
    expect(labels).toContain("  Synthetic Health (INS-A)");
    expect(labels).toContain("  INS-B");
    expect(Object.fromEntries(sec.rows).Compared).toBe("per payer");
  });

  it("no Tally data says why", () => {
    const sec = insReceivableSection(controlsWith(block({ tally_state: "no_data", tally: null })));
    const rows = Object.fromEntries(sec.rows);
    expect(rows.Status).toBe("No Tally data");
    expect(rows["Tally insurer receivable at 2026-09-30"]).toMatch(/nothing mirrored from Tally/);
  });

  it("an older pack shows the control as not captured; the section list includes it once", () => {
    const sec = insReceivableSection(controlsWith(undefined));
    expect(sec.rows[0][1]).toMatch(/Not captured/);
    const titles = controlSections(controlsWith(block())).map((s) => s.key ?? s.title);
    expect(titles.filter((t) => t === "ins_receivable")).toHaveLength(1);
  });

  it("the explanation line for Excel and PDF", () => {
    expect(insNoteText(null)).toBeNull();
    expect(insNoteText(undefined)).toBeNull();
    expect(insNoteText({ state: "missing", text: null, at: null, by: null })).toBe(
      "Not yet explained.",
    );
    expect(insNoteText({ state: "stale", text: null, at: null, by: null })).toMatch(/earlier/);
    expect(
      insNoteText({
        state: "given",
        text: "Two remittances posted in Tally on 1 Oct.",
        at: "2026-10-04",
        by: "A Preparer",
      }),
    ).toBe("Two remittances posted in Tally on 1 Oct. (A Preparer, 2026-10-04)");
  });
});

describe("Excel and PDF from the frozen pack", () => {
  const sign: SignOff = {
    financeBy: null,
    financeAt: null,
    financeNote: null,
    ceoBy: null,
    ceoAt: null,
    ceoNote: null,
    lockedAt: null,
    hash: null,
    insNote: {
      state: "given",
      text: "INS-B remittance posted in Tally on 1 Oct.",
      at: "2026-10-04",
      by: "A Preparer",
    },
  };
  const pack = buildClosePack({
    ...(closeFixture as unknown as ClosePackInput),
    controls: controlsWith(block()),
  });

  it("the workbook holds the control, the matter and the explanation", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await closePackXlsx(pack, sign)) as never);
    const text = (name: string) => {
      const lines: string[] = [];
      wb.getWorksheet(name)!.eachRow((r) => lines.push(String(r.values)));
      return lines.join("\n");
    };
    expect(text("Controls")).toContain("Insurance receivable control (Diligence and Tally)");
    expect(text("Controls")).toContain("Tally insurer receivable at 2026-09-30");
    expect(text("Controls")).toContain("differs from Diligence (AED 800.00) by AED 20.00");
    expect(text("Summary")).toContain(
      "INS-B remittance posted in Tally on 1 Oct. (A Preparer, 2026-10-04)",
    );
  });

  it("the PDF holds the control and the explanation", async () => {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const buf = await closePackPdf(pack, sign);
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(buf)), {
      mergePages: true,
    });
    const all = (Array.isArray(text) ? text.join("\n") : text).replace(/\s+/g, " ");
    expect(all).toContain("Insurance receivable control (Diligence and Tally)");
    expect(all).toContain("Preparer's explanation: INS-B remittance posted in Tally on 1 Oct.");
  });
});
