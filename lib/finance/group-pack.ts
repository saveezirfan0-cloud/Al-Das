import type { PayablesAgeing } from "@/lib/accounting/payables-ageing";
import type { ClosePack } from "@/lib/finance/close-pack";
import { monthLabel } from "@/lib/finance/close-pack";
import type { Counts } from "@/lib/finance/doctor-performance";
import type { TableColumn, TableSheet } from "@/lib/export/table-xlsx";

/**
 * docs/51: Al Das's own submission for the Bindrai group reporting pack (pure). It fills the Al Das tabs of the
 * Group Financial Reporting Pack and the Rollout Pack's Clinic Branch Source Data from figures Pulse already has: the
 * Unite report (23A/23B), the month-end close pack (frozen when one was built, else live), the ledger's profit and loss
 * (the Tally mirror) and the payables ageing. The group consolidation, the other entities, intercompany, the 13-week cash
 * forecast, commitments, compliance and the acknowledgement registers stay in the workbooks (OQ-183).
 *
 * Every cell is a plain value (no formulas); a figure Pulse does not have is left blank with the reason, never 0.
 * Counts, amounts and branch, supplier and step names only: no patient data.
 */

export type BranchFigures = Counts & {
  code: string;
  name: string;
  cancelledVisits: number;
};

export type ClinicFigures = Counts & {
  cancelledVisits: number;
  previous: Counts;
  /** The revenue-per-patient target (fin_ref_finance_settings.perf_arpp_target). */
  arppTarget: number;
  /** Which days of the month the Unite report covers, and whether that is every day. */
  coverage: { label: string; full: boolean };
};

export type PlTotals = {
  direct_income: number;
  direct_expense: number;
  gross_profit: number;
  indirect_income: number;
  indirect_expense: number;
  net_profit: number;
};

/** Why a section is empty, written in the sheet instead of the figures. */
export type Missing = { missing: string };

export type PlSection = {
  month: PlTotals;
  ytd: PlTotals;
  ytdFrom: string;
  provisional: boolean;
  /** No journal line at all in the year to date (the Tally import has not run). */
  empty: boolean;
};

export type CloseStatus = "open" | "built" | "finance_signed" | "locked";

export type CloseTaskRow = {
  step: string;
  title: string;
  owner: string | null;
  dueWd: number;
  status: "open" | "done" | "blocked";
  doneAt: string | null;
  blockedReason: string | null;
};

export type SignOffFacts = {
  financeBy: string | null;
  financeAt: string | null;
  ceoBy: string | null;
  ceoAt: string | null;
  lockedAt: string | null;
  hash: string | null;
};

export type GroupPackInput = {
  org: string;
  /** YYYY-MM-01 */
  month: string;
  builtAt: string;
  status: CloseStatus;
  /** One entry per finance branch (fin_ref_branches), in the order to show. */
  branches: BranchFigures[];
  /** The whole clinic from the Unite report, or null when the month has no report rows. */
  clinic: ClinicFigures | null;
  /** The month's total revenue and patient targets (daily target × days in the month), or null when none is set. */
  targets: { revenue: number | null; patients: number | null };
  /** The close pack: the frozen snapshot when the month was built, otherwise built live for this download. */
  close: { pack: ClosePack; frozen: boolean } | null;
  pl: PlSection | Missing;
  payables: PayablesAgeing | Missing;
  tasks: CloseTaskRow[];
  sign: SignOffFacts | null;
};

export const NOT_IN_PULSE = {
  payroll: "Not in Pulse yet: payroll per doctor and staff is not loaded (Q20).",
  supplies: "Not in Pulse yet: supplier and consumable costs are not loaded (D7, D8).",
  committed: "Not in Pulse: there is no commitment register (docs/51 §2).",
  appointments:
    "Needs the Unite appointment export (D16): Pulse counts booked, honoured and cancelled appointments from it.",
} as const;

const r2 = (n: number) => Math.round(n * 100) / 100;
const isMissing = (v: unknown): v is Missing =>
  !!v && typeof v === "object" && "missing" in (v as Record<string, unknown>);

export function statusLabel(status: CloseStatus, sign: SignOffFacts | null): string {
  switch (status) {
    case "locked":
      return `Locked: signed by Finance and the CEO${sign?.lockedAt ? ` (${sign.lockedAt.slice(0, 10)})` : ""}.`;
    case "finance_signed":
      return "Provisional: signed by Finance, waiting for the CEO sign-off.";
    case "built":
      return "Provisional: the close pack is built but not signed.";
    default:
      return "Provisional: the month has not been closed in Pulse.";
  }
}

/** Visits − patients, never below 0 (Phase 23B follow-ups; the pack's "repeat visits", OQ-186). */
export const repeatVisits = (c: Pick<Counts, "visits" | "patients">) =>
  Math.max(0, c.visits - c.patients);

const perPatient = (c: Pick<Counts, "revenue" | "patients">): number | null =>
  c.patients > 0 ? r2(c.revenue / c.patients) : null;

const diff = (a: number | null, b: number | null): number | null =>
  a === null || b === null ? null : r2(a - b);

/** A close-pack branch code that is one of the finance branches, else null ("not assigned"). */
function packBranch(pack: ClosePack, code: string) {
  return pack.by_branch.find((b) => b.branch === code) ?? null;
}

export function buildGroupPack(input: GroupPackInput): TableSheet[] {
  const title = monthLabel(input.month);
  const head = [`Reporting month: ${title}`, statusLabel(input.status, input.sign)];
  const pack = input.close?.pack ?? null;
  const c = input.clinic;
  const coverageNote = c
    ? c.coverage.full
      ? `Unite report: ${c.coverage.label}.`
      : `Unite report covers only ${c.coverage.label}; figures are for those days.`
    : "No Unite report rows for this month.";

  // ---- Read Me ------------------------------------------------------------------------------------------------------
  const readMe: TableSheet = {
    sheet: "Read Me",
    title: "Al Das submission for the Bindrai group reporting pack",
    lines: head,
    columns: [
      { header: "Item", width: 34 },
      { header: "Detail", width: 110 },
    ],
    rows: [
      ["Entity", input.org],
      ["Reporting month", title],
      ["Status", statusLabel(input.status, input.sign)],
      [
        "Finance sign-off",
        input.sign?.financeBy
          ? `${input.sign.financeBy}, ${input.sign.financeAt?.slice(0, 10) ?? ""}`
          : "Not signed",
      ],
      [
        "CEO sign-off",
        input.sign?.ceoBy
          ? `${input.sign.ceoBy}, ${input.sign.ceoAt?.slice(0, 10) ?? ""}`
          : "Not signed",
      ],
      ["Close pack fingerprint (sha256)", input.sign?.hash ?? "None"],
      ["Revenue and patients", coverageNote],
      [
        "Insurance and collections",
        pack
          ? input.close?.frozen
            ? `The month-end close pack as frozen on ${pack.built_at.slice(0, 10)}.`
            : "Built live for this download (no close pack has been frozen for the month yet)."
          : "No close pack figures.",
      ],
      [
        "Profit and loss",
        isMissing(input.pl)
          ? input.pl.missing
          : `The ledger (Tally mirror), ${input.pl.provisional ? "provisional" : "final"}; year to date from ${input.pl.ytdFrom}.`,
      ],
      [
        "Payables",
        isMissing(input.payables)
          ? input.payables.missing
          : `Supplier invoices and vouchers in Pulse as at ${input.payables.asOf}.`,
      ],
      [
        "Completed in the group workbook, not here",
        "Group Dashboard, Cash 13W, Commitments & Capex, Intercompany, Compliance, Budget & Forecast, the CEO scorecard and the acknowledgement registers.",
      ],
      [
        "Blank cells",
        "A blank figure means Pulse does not have it yet; the reason is written beside it. It is never zero.",
      ],
      ["Patient data", "None. Counts and amounts only."],
    ],
  };

  // ---- Entity P&L ---------------------------------------------------------------------------------------------------
  const plCols: TableColumn[] = [
    { header: "Line item", width: 44 },
    { header: "Month actual", kind: "money" },
    { header: "YTD actual", kind: "money" },
    { header: "Source / note", width: 90 },
  ];
  let plRows: Array<Array<string | number | null>>;
  if (isMissing(input.pl)) {
    plRows = [["Profit and loss", null, null, input.pl.missing]];
  } else {
    const { month: m, ytd: y } = input.pl;
    const margin = (t: PlTotals) =>
      t.direct_income !== 0 ? Math.round((t.gross_profit / t.direct_income) * 1000) / 10 : null;
    const operating = (t: PlTotals) => r2(t.indirect_expense - t.indirect_income);
    const note = input.pl.empty ? "No ledger postings yet (the Tally import has not run)." : "";
    plRows = [
      [
        "Revenue (Sales Accounts and Direct Incomes)",
        m.direct_income,
        y.direct_income,
        note || "Ledger",
      ],
      [
        "Direct costs / cost of sales",
        m.direct_expense,
        y.direct_expense,
        "Purchase Accounts and Direct Expenses",
      ],
      ["Gross profit", m.gross_profit, y.gross_profit, "Revenue − direct costs"],
      ["Gross margin %", margin(m), margin(y), "Gross profit ÷ revenue × 100"],
      [
        "Operating expenses, net of other income",
        operating(m),
        operating(y),
        "Indirect Expenses − Indirect Incomes. Payroll, depreciation, finance costs and tax are inside this line until the Tally groups are mapped to the pack's lines (OQ-186).",
      ],
      ["Net result", m.net_profit, y.net_profit, "Gross profit + other income − indirect expenses"],
      [
        "Memo: revenue per the Unite report (net billing)",
        c ? c.revenue : null,
        null,
        c
          ? `Unite NET BILLING, after discount, before VAT. ${coverageNote}`
          : "No Unite report rows for this month.",
      ],
      [
        "Memo: Unite revenue − ledger revenue",
        c ? diff(c.revenue, m.direct_income) : null,
        null,
        "Explain any difference (timing of Tally entries, revenue not billed in Unite).",
      ],
    ];
  }
  const entityPl: TableSheet = {
    sheet: "Entity P&L",
    title: "Entity P&L (actuals; budget and forecast are completed in the group workbook)",
    lines: head,
    columns: plCols,
    rows: plRows,
  };

  // ---- KPI Scorecard (Al Das section) -------------------------------------------------------------------------------
  const kpiCols: TableColumn[] = [
    { header: "KPI", width: 40 },
    { header: "Month actual", kind: "number" },
    { header: "Target", kind: "number" },
    { header: "Actual − target", kind: "number" },
    { header: "Prior month", kind: "number" },
    { header: "Source / note", width: 90 },
  ];
  const kpi: Array<Array<string | number | null>> = [];
  if (c) {
    kpi.push(
      [
        "Revenue, AED",
        c.revenue,
        input.targets.revenue,
        diff(c.revenue, input.targets.revenue),
        c.previous.revenue,
        `Unite net billing. ${coverageNote}`,
      ],
      [
        "Patients (distinct)",
        c.patients,
        input.targets.patients,
        diff(c.patients, input.targets.patients),
        c.previous.patients,
        "Each patient counted once in the month.",
      ],
      ["Visits", c.visits, null, null, c.previous.visits, "Unite report rows."],
      [
        "New patients (visits marked New)",
        c.newVisits,
        null,
        null,
        c.previous.newVisits,
        "Unite's New flag (OQ-186).",
      ],
      [
        "Repeat visits (visits − patients)",
        repeatVisits(c),
        null,
        null,
        repeatVisits(c.previous),
        "Pulse's follow-up measure (Q9, OQ-186).",
      ],
      [
        "Revenue per patient, AED",
        perPatient(c),
        c.arppTarget,
        diff(perPatient(c), c.arppTarget),
        perPatient(c.previous),
        "Revenue ÷ patients.",
      ],
      [
        "Cancelled visits (Unite report)",
        c.cancelledVisits,
        null,
        null,
        null,
        `Cancellation and no-show rate: ${NOT_IN_PULSE.appointments}`,
      ],
    );
  } else {
    kpi.push([
      "Revenue, patients and visits",
      null,
      null,
      null,
      null,
      "No Unite report rows for this month: upload the Unite collection report.",
    ]);
  }
  if (pack) {
    const t = pack.totals;
    const over90 = pack.ageing.find((a) => a.bucket === "90+");
    kpi.push(
      [
        "Cash collections, AED",
        t.collected,
        null,
        null,
        null,
        "Unite payments dated in the month (all modes).",
      ],
      [
        "Insurance claims submitted, AED",
        t.claimed,
        null,
        null,
        null,
        `${t.claims} claim lines (Diligence, by service month).`,
      ],
      [
        "Insurance claims rejected, AED",
        t.rejected,
        null,
        null,
        null,
        "Diligence, by service month.",
      ],
      [
        "Insurance claims pending, AED",
        t.outstanding,
        null,
        null,
        null,
        "Net − remitted − approved write-off, by service month.",
      ],
      [
        "Aged insurer receivables over 90 days, AED",
        over90 ? over90.outstanding : 0,
        null,
        null,
        null,
        "All months, aged from the service date to the day the pack was built.",
      ],
    );
  } else {
    kpi.push([
      "Collections and insurance",
      null,
      null,
      null,
      null,
      "No close pack figures for this month.",
    ]);
  }
  kpi.push(
    ["Payroll as % of revenue", null, null, null, null, NOT_IN_PULSE.payroll],
    ["Medical supplies as % of revenue", null, null, null, null, NOT_IN_PULSE.supplies],
  );
  const kpiSheet: TableSheet = {
    sheet: "KPI Scorecard",
    title: "KPI Scorecard: Al Das Medical Clinic / Branches",
    lines: head,
    columns: kpiCols,
    rows: kpi,
  };

  // ---- Clinic Branch Source Data ------------------------------------------------------------------------------------
  const bCols: TableColumn[] = [
    { header: "Metric", width: 36 },
    ...input.branches.map((b) => ({ header: b.name, kind: "number" as const })),
    { header: "Not assigned to a branch", kind: "number" },
    { header: "Al Das total", kind: "number" },
    { header: "Source / note", width: 80 },
  ];
  const unite = (
    label: string,
    f: (x: Counts & { cancelledVisits: number }) => number | null,
    note: string,
    additive: boolean,
  ): Array<string | number | null> => {
    const total = c ? f(c) : null;
    // no report rows for the month: every branch is blank too (never 0)
    const parts = input.branches.map((b) => (c ? f(b) : null));
    const rest =
      additive && total !== null
        ? r2(total - parts.reduce<number>((a, v) => a + (v ?? 0), 0))
        : null;
    return [label, ...parts, rest, total, note];
  };
  const bRows: Array<Array<string | number | null>> = [
    unite(
      "Revenue, AED",
      (x) => x.revenue,
      "Unite net billing; branch from the Unite clinic name (aliases included).",
      true,
    ),
    unite("Visits", (x) => x.visits, "Unite report rows.", true),
    unite(
      "Patients (distinct)",
      (x) => x.patients,
      "A patient seen at two branches counts in each, once in the total: branches do not add up to the total.",
      false,
    ),
    unite("New patients (visits marked New)", (x) => x.newVisits, "Unite's New flag.", true),
    unite(
      "Repeat visits (visits − patients)",
      (x) => repeatVisits(x),
      "Per branch and for the clinic; not additive.",
      false,
    ),
    unite("Revenue per patient, AED", (x) => perPatient(x), "Revenue ÷ patients.", false),
    unite("Cancelled visits", (x) => x.cancelledVisits, "Rows Unite marks cancelled.", true),
  ];
  if (pack) {
    const known = new Set(input.branches.map((b) => b.code));
    const packRow = (
      label: string,
      key: "claimed" | "remitted" | "rejected" | "outstanding" | "self_pay_collected",
      note: string,
    ): Array<string | number | null> => {
      const parts = input.branches.map((b) => packBranch(pack, b.code)?.[key] ?? 0);
      const rest = r2(
        pack.by_branch.filter((b) => !known.has(b.branch)).reduce((a, b) => a + b[key], 0),
      );
      return [label, ...parts, rest, r2(pack.by_branch.reduce((a, b) => a + b[key], 0)), note];
    };
    bRows.push(
      packRow(
        "Insurance claims submitted, AED",
        "claimed",
        "Diligence; the branch comes from the matched Unite invoice, so unmatched claims are not assigned.",
      ),
      packRow("Insurance cash received, AED", "remitted", "Remitted per Diligence."),
      packRow("Insurance claims rejected, AED", "rejected", "Diligence."),
      packRow(
        "Insurance claims pending, AED",
        "outstanding",
        "Net − remitted − approved write-off.",
      ),
      packRow(
        "Self-pay collected, AED",
        "self_pay_collected",
        "Payments on self-pay invoices dated in the month.",
      ),
    );
  }
  const blanks = input.branches.map(() => null);
  bRows.push(
    ["Appointments / procedures", ...blanks, null, null, NOT_IN_PULSE.appointments],
    ["Payroll cost, AED", ...blanks, null, null, NOT_IN_PULSE.payroll],
    ["Medical supplies cost, AED", ...blanks, null, null, NOT_IN_PULSE.supplies],
    ["Committed spend, AED", ...blanks, null, null, NOT_IN_PULSE.committed],
  );
  const branchSheet: TableSheet = {
    sheet: "Clinic Branch Source Data",
    title: "Clinic Branch Source Data (every finance branch; Shoreline included, OQ-185)",
    lines: [
      ...head,
      `${input.branches.length} branches. Totals are Pulse's own, never the sum of rates.`,
    ],
    columns: bCols,
    rows: bRows,
  };

  // ---- Working capital ----------------------------------------------------------------------------------------------
  const receivables: TableSheet = {
    sheet: "Receivables ageing",
    title: "Working Capital: insurer receivables by age (Diligence)",
    lines: [
      ...head,
      pack
        ? `Aged from the service date to ${pack.built_at.slice(0, 10)}, when the close pack was built (not the month end).`
        : "No close pack figures for this month.",
    ],
    columns: [
      { header: "Age (days)", width: 14 },
      { header: "Claim lines", kind: "number" },
      { header: "Outstanding, AED", kind: "money" },
    ],
    rows: pack
      ? ["0-30", "31-60", "61-90", "90+"].map((bucket) => {
          const a = pack.ageing.find((x) => x.bucket === bucket);
          return [bucket, a?.claims ?? 0, a?.outstanding ?? 0];
        })
      : [],
    totals: pack
      ? [
          "Total",
          pack.ageing.reduce((a, x) => a + x.claims, 0),
          r2(pack.ageing.reduce((a, x) => a + x.outstanding, 0)),
        ]
      : undefined,
  };

  const payCols: TableColumn[] = [
    { header: "Supplier", width: 36 },
    { header: "Not yet due", kind: "money" },
    { header: "1-30 days", kind: "money" },
    { header: "31-60 days", kind: "money" },
    { header: "61-90 days", kind: "money" },
    { header: "91-120 days", kind: "money" },
    { header: "Over 120 days", kind: "money" },
    { header: "Paid on account", kind: "money" },
    { header: "Total", kind: "money" },
  ];
  const payRow = (name: string, x: PayablesAgeing["totals"]) => [
    name,
    x.buckets.current,
    x.buckets.d1_30,
    x.buckets.d31_60,
    x.buckets.d61_90,
    x.buckets.d91_120,
    x.buckets.d120_plus,
    x.onAccount,
    x.total,
  ];
  const payables: TableSheet = isMissing(input.payables)
    ? {
        sheet: "Payables ageing",
        title: "Working Capital: supplier payables by age",
        lines: [...head, input.payables.missing],
        columns: payCols,
        rows: [],
      }
    : {
        sheet: "Payables ageing",
        title: "Working Capital: supplier payables by age (days overdue)",
        lines: [
          ...head,
          `As at ${input.payables.asOf}. Supplier invoices and vouchers recorded in Pulse; bills entered only in Tally are not here.`,
        ],
        columns: payCols,
        rows: input.payables.rows.map((r) => payRow(r.name, r)),
        totals: payRow("Total", input.payables.totals),
      };

  // ---- Close & Sign-off ---------------------------------------------------------------------------------------------
  const STATUS: Record<CloseTaskRow["status"], string> = {
    open: "Open",
    done: "Done",
    blocked: "Blocked",
  };
  const closeSheet: TableSheet = {
    sheet: "Close & Sign-off",
    title: "Month-end close checklist (Pulse close timetable)",
    lines: [
      ...head,
      `Finance: ${input.sign?.financeBy ?? "not signed"}. CEO: ${input.sign?.ceoBy ?? "not signed"}.`,
    ],
    columns: [
      { header: "Step", width: 18 },
      { header: "Task", width: 60 },
      { header: "Owner", width: 26 },
      { header: "Due (working day)", kind: "number" },
      { header: "Status", width: 12 },
      { header: "Completed", width: 12 },
      { header: "Blocked because", width: 50 },
    ],
    rows: input.tasks.map((t) => [
      t.step,
      t.title,
      t.owner,
      t.dueWd,
      STATUS[t.status],
      t.doneAt ? t.doneAt.slice(0, 10) : null,
      t.blockedReason,
    ]),
  };

  const definitions: TableSheet = {
    sheet: "Definitions",
    title: "Definitions",
    lines: [`Reporting month: ${title}`],
    columns: [
      { header: "Term", width: 34 },
      { header: "Meaning", width: 110 },
    ],
    rows: GROUP_PACK_DEFINITIONS.map(([a, b]) => [a, b]),
  };

  return [readMe, entityPl, kpiSheet, branchSheet, receivables, payables, closeSheet, definitions];
}

export const GROUP_PACK_DEFINITIONS: readonly (readonly [string, string])[] = [
  [
    "Revenue (Unite)",
    "Unite NET BILLING from the Daily Collection report uploads: after discount, before VAT, by report date.",
  ],
  ["Revenue (ledger)", "Tally's Sales Accounts and Direct Incomes as mirrored in Pulse's ledger."],
  ["Patients", "Distinct patients in the month. A branch or the clinic counts each patient once."],
  ["New patients", "Visits Unite marks New."],
  ["Repeat visits", "Visits − patients within the month (never below 0)."],
  [
    "Revenue per patient",
    "Revenue ÷ patients; the target is the revenue-per-patient target in Finance settings.",
  ],
  ["Targets", "The month's revenue and patient targets: the daily target × the days in the month."],
  [
    "Branch",
    "Derived from the Unite clinic name (and its old names) for each row; a row whose clinic is not mapped is not assigned.",
  ],
  [
    "Insurance figures",
    "Diligence claims by service month: claimed (net), remitted, rejected, pending (net − remitted − approved write-off).",
  ],
  [
    "Receivables ageing",
    "Pending insurer amounts by days since the service date, on the day the close pack was built.",
  ],
  [
    "Payables ageing",
    "Supplier invoices less vouchers paid against them, by days past the due date.",
  ],
  ["Provisional", "Every figure is provisional until the CEO sign-off locks the month in Pulse."],
];
