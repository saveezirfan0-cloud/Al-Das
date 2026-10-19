import {
  readInsReceivable,
  recompute,
  snapshotStatus,
  STATUS_LABEL,
  TALLY_STATE_TEXT,
  type InsReceivableBlock,
} from "@/lib/finance/insurance-receivable-control";

/**
 * Phase 20G part 2: the Board pack control summary (pure). `fin_close_controls` (SQL) returns the summary when the pack
 * is built; it is frozen into the pack snapshot together with the "matters needing attention" derived here, so both are
 * covered by the pack's sha256 and a pack downloaded later shows what was signed. Counts, amounts, statuses and dates
 * only. A block that is null means the feature is not set up (no data at all), never zero.
 */

export type CountAmount = { count: number; amount: number };

export type BankRecStatus = "none" | "open" | "reviewed" | "signed";

export type BankAccountControl = {
  account_id: string;
  name: string;
  last4: string;
  status: BankRecStatus;
  period_end: string | null;
  /** Expected receipts not found on the statement: known once the month's reconciliation is reviewed, else null. */
  expected_unmatched: CountAmount | null;
  /** Bank credits up to the month end that are unmatched and carry no reason; age at the build date. */
  bank_unexplained: CountAmount & { oldest_days: number | null; over_limit: number };
};

export const VOUCHER_STAGES = ["submitted", "checked", "dept_approved", "for_tally"] as const;
export type VoucherStage = (typeof VOUCHER_STAGES)[number];

export type CloseControls = {
  version: 1;
  month: string;
  month_end: string;
  /** The build date in the clinic's time zone: ages and workflow states are as at this day. */
  as_of: string;
  settings: {
    item_max_age_days: number;
    voucher_unpaid_days: number;
    receivables_over90_pct: number;
    inputs_wd: number;
    revshare_wd: number;
  };
  bank: { accounts: BankAccountControl[] } | null;
  payables: {
    invoices_unpaid: CountAmount;
    by_age: Array<CountAmount & { bucket: string }>;
    vouchers_approved_unpaid: CountAmount & { oldest_days: number | null; over_limit: CountAmount };
    vouchers_waiting: Record<VoucherStage, CountAmount>;
  } | null;
  revenue_share: {
    run_status: "none" | "draft" | "verified" | "approved" | "posted" | "paid";
    approved_on: string | null;
    due_on: string | null;
    liability: {
      total: number;
      runs: Array<{ month: string; status: string; doctors: number; unpaid: number }>;
    };
  } | null;
  invoice_changes: { measured: false } | { measured: true; from: string; unapproved: CountAmount };
  receivables: {
    open_claims: number;
    outstanding: number;
    over_90: CountAmount;
    over_90_pct: number | null;
  } | null;
  timetable: {
    tasks: number;
    done: number;
    blocked: number;
    inputs_wd: number;
    inputs_due_on: string | null;
    inputs: { total: number; on_time: number; late: number; pending: number };
  } | null;
  exceptions: { open: number; oldest_days: number | null; over_limit: number };
  /**
   * docs/48: Diligence insurance receivable beside Tally's insurer receivable at the month end. Absent in packs built
   * before it (rendered "not captured"); read it with readInsReceivable().
   */
  ins_receivable?: InsReceivableBlock | null;
};

export type Matter = { key: string; text: string };

/** The stored jsonb of fin_close_controls, or null when it is not a version 1 summary. */
export function readControls(json: unknown): CloseControls | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Partial<CloseControls>;
  if (o.version !== 1 || typeof o.month !== "string" || !o.settings || !o.exceptions) return null;
  if (!o.invoice_changes || typeof o.invoice_changes.measured !== "boolean") return null;
  return o as CloseControls;
}

/** 12,345.60 without depending on the runtime's locale data (the text is frozen into the pack). */
export function amountText(n: number): string {
  const [whole, cents] = Math.abs(n).toFixed(2).split(".");
  return `${n < 0 ? "-" : ""}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const BANK_STATUS: Record<BankRecStatus, string> = {
  none: "not started",
  open: "open (not reviewed)",
  reviewed: "reviewed, not signed",
  signed: "signed",
};

const RUN_DONE = new Set(["approved", "posted", "paid"]);

/** What the Board should look at, derived from the summary alone (deterministic; thresholds are in the summary). */
export function deriveMatters(c: CloseControls): Matter[] {
  const s = c.settings;
  const out: Matter[] = [];
  for (const a of c.bank?.accounts ?? []) {
    const label = `${a.name} (ending ${a.last4})`;
    if (a.status !== "signed")
      out.push({
        key: `bank_unsigned:${a.account_id}`,
        text: `Bank reconciliation for ${label} is ${BANK_STATUS[a.status] ?? a.status}.`,
      });
    if (a.bank_unexplained.over_limit > 0)
      out.push({
        key: `bank_old:${a.account_id}`,
        text: `${label}: ${plural(a.bank_unexplained.over_limit, "bank credit")} unmatched and unexplained for more than ${s.item_max_age_days} days (oldest ${a.bank_unexplained.oldest_days ?? "?"} days).`,
      });
  }
  const late = c.payables?.vouchers_approved_unpaid.over_limit;
  if (late && late.count > 0)
    out.push({
      key: "vouchers_unpaid",
      text: `${plural(late.count, "approved voucher")} (AED ${amountText(late.amount)}) not paid within ${s.voucher_unpaid_days} days of approval.`,
    });
  const rs = c.revenue_share;
  if (rs) {
    const due = `working day ${s.revshare_wd}${rs.due_on ? `, ${rs.due_on}` : ""}`;
    if (!RUN_DONE.has(rs.run_status))
      out.push({
        key: "revshare_unapproved",
        text: `The revenue-share run for the month is not approved (${rs.run_status === "none" ? "no run yet" : `status ${rs.run_status}`}; due by ${due}).`,
      });
    else if (!rs.due_on || !rs.approved_on || rs.approved_on > rs.due_on)
      out.push({
        key: "revshare_late",
        text: `The revenue-share run was approved ${rs.approved_on ? `on ${rs.approved_on}` : "on an unknown date"}, after ${due}.`,
      });
  }
  const ic = c.invoice_changes;
  if (ic.measured && ic.unapproved.count > 0)
    out.push({
      key: "invoice_changes",
      text: `${plural(ic.unapproved.count, "invoice change")} without approval in the month (AED ${amountText(ic.unapproved.amount)}).`,
    });
  const rc = c.receivables;
  if (rc && rc.over_90_pct !== null && rc.over_90_pct > s.receivables_over90_pct)
    out.push({
      key: "receivables_old",
      text: `${rc.over_90_pct}% of insurance receivables (AED ${amountText(rc.over_90.amount)}) are over 90 days old; the limit is ${s.receivables_over90_pct}%.`,
    });
  const tt = c.timetable;
  if (tt && tt.inputs.late > 0)
    out.push({
      key: "inputs_late",
      text: `${plural(tt.inputs.late, "close input")} due by working day ${tt.inputs_wd} ${tt.inputs.late === 1 ? "was" : "were"} late or ${tt.inputs.late === 1 ? "is" : "are"} still missing.`,
    });
  if (tt && tt.blocked > 0)
    out.push({ key: "steps_blocked", text: `${plural(tt.blocked, "close step")} blocked.` });
  // the same status the database re-checks at the finance sign-off (app.fin_close_ins_status)
  const ir = readInsReceivable(c.ins_receivable);
  const irResult = ir ? recompute(ir) : null;
  if (snapshotStatus(c) === "differs")
    out.push({
      key: "ins_receivable_differs",
      text:
        !ir || !irResult || irResult.difference === null
          ? "The insurance receivable control could not be read; it counts as a difference and needs an explanation before Finance signs."
          : `Insurance receivable: Tally (AED ${amountText(irResult.tally_total ?? 0)}) differs from Diligence (AED ${amountText(irResult.diligence_total ?? 0)}) by AED ${amountText(irResult.difference)}${irResult.basis === "per_payer" ? ` (${plural(irResult.payers.filter((p) => !p.agrees).length, "payer")} outside the tolerance)` : ""}; the tolerance is AED ${amountText(typeof ir.tolerance === "number" ? ir.tolerance : 0)}. Finance signs only after the preparer explains it.`,
    });
  if (c.exceptions.over_limit > 0)
    out.push({
      key: "exceptions_old",
      text: `${plural(c.exceptions.over_limit, "open finance exception")} older than ${s.item_max_age_days} days (oldest ${c.exceptions.oldest_days ?? "?"} days).`,
    });
  return out;
}

/** Said wherever the controls are shown: what the Board pack does not hold. */
export const CONTROLS_SCOPE = [
  "Profit and loss: the P&L in Pulse is the provisional profitability view (Finance, Profitability); its figures stay Provisional until Finance approves the month.",
  "Balance sheet: comes from Tally, not from Pulse.",
  "Employee incentive liabilities: not held in Pulse yet.",
];

export const NOT_CAPTURED =
  "Not captured in this pack: it was built before the control summary existed.";

export const NOT_SET_UP = "Not set up";

export type ControlSection = { key?: string; title: string; rows: Array<[string, string]> };

export const INS_RECEIVABLE_TITLE = "Insurance receivable control (Diligence and Tally)";

/** The insurance receivable control as label / value rows (page, Excel and PDF), from the frozen block only. */
export function insReceivableSection(c: CloseControls): ControlSection {
  const key = "ins_receivable";
  if (c.ins_receivable === undefined)
    return {
      key,
      title: INS_RECEIVABLE_TITLE,
      rows: [["Control", "Not captured in this pack: it was built before this control existed."]],
    };
  const b = readInsReceivable(c.ins_receivable);
  if (!b)
    return {
      key,
      title: INS_RECEIVABLE_TITLE,
      rows: [["Status", "Differs (the stored control could not be read)"]],
    };
  const r = recompute(b);
  const amt = (n: number | null) => (n === null ? "none" : `AED ${amountText(n)}`);
  const name = (id: string) => (b.payer_names?.[id] ? `${b.payer_names[id]} (${id})` : id);
  const rows: Array<[string, string]> = [
    ["Status", STATUS_LABEL[r.status]],
    [
      `Diligence receivable at ${b.month_end}`,
      r.diligence_total === null && r.status !== "differs"
        ? "no Diligence claims up to the month end"
        : amt(r.diligence_total),
    ],
    [
      `Tally insurer receivable at ${b.month_end}`,
      b.tally_state === "mirrored"
        ? amt(r.tally_total)
        : (TALLY_STATE_TEXT[b.tally_state] ?? String(b.tally_state)),
    ],
  ];
  if (r.difference !== null) rows.push(["Difference (Tally minus Diligence)", amt(r.difference)]);
  rows.push(["Tolerance", amt(typeof b.tolerance === "number" ? b.tolerance : 0)]);
  if (r.basis === "per_payer") rows.push(["Compared", "per payer"]);
  if (r.basis === "total")
    rows.push([
      "Compared",
      `in total (without a payer: Diligence ${amt(r.unassigned_diligence)}, Tally ${amt(r.unassigned_tally)})`,
    ]);
  for (const p of r.payers)
    rows.push([
      `  ${name(p.payer_id)}`,
      `Diligence ${amt(p.diligence)}, Tally ${amt(p.tally)}, difference ${amt(p.difference)}${p.agrees ? "" : " (differs)"}`,
    ]);
  const ledgers = (b.accounts ?? []).map((a) => `${a.code} ${a.name}`).join("; ");
  rows.push(["Tally ledger(s)", ledgers || "none mapped"]);
  rows.push([
    "Tally figures as fresh as",
    b.tally_last_mirrored_at
      ? `last Tally voucher mirrored ${b.tally_last_mirrored_at.slice(0, 16).replace("T", " ")} (latest voucher date ${b.tally_last_voucher_date ?? "unknown"})`
      : "nothing mirrored from Tally yet",
  ]);
  if (b.remitted_after && b.remitted_after.claims > 0)
    rows.push([
      "Remitted after the month end, added back",
      `${plural(b.remitted_after.claims, "claim")}, AED ${amountText(b.remitted_after.amount)}`,
    ]);
  if (b.remitted_straddling > 0)
    rows.push([
      "Remitted before and after the month end (all deducted)",
      plural(b.remitted_straddling, "claim"),
    ]);
  return { key, title: INS_RECEIVABLE_TITLE, rows };
}

const ca = (x: CountAmount) => `${x.count}, AED ${amountText(x.amount)}`;
const days = (n: number | null) => (n === null ? "none" : `${n} days`);

/** The summary as label / value rows, one section per control (the same text on the page, in Excel and in the PDF). */
export function controlSections(c: CloseControls): ControlSection[] {
  const sections: ControlSection[] = [];
  sections.push({
    title: "Bank reconciliations",
    rows: c.bank
      ? c.bank.accounts.flatMap((a): Array<[string, string]> => [
          [`${a.name} (ending ${a.last4})`, BANK_STATUS[a.status] ?? a.status],
          [
            "  Expected receipts not found",
            a.expected_unmatched ? ca(a.expected_unmatched) : "known once the month is reviewed",
          ],
          ["  Bank credits unmatched and unexplained", ca(a.bank_unexplained)],
          ["  Oldest of those", days(a.bank_unexplained.oldest_days)],
        ])
      : [["Bank reconciliation", NOT_SET_UP]],
  });
  const p = c.payables;
  sections.push({
    title: "Payables",
    rows: p
      ? [
          ["Supplier invoices unpaid at month end", ca(p.invoices_unpaid)],
          ...p.by_age.map((b): [string, string] => [`  ${b.bucket} days`, ca(b)]),
          ["Approved vouchers not paid", ca(p.vouchers_approved_unpaid)],
          ["  Oldest since approval", days(p.vouchers_approved_unpaid.oldest_days)],
          [
            `  Unpaid more than ${c.settings.voucher_unpaid_days} days`,
            ca(p.vouchers_approved_unpaid.over_limit),
          ],
          ["Vouchers to verify", ca(p.vouchers_waiting.submitted)],
          ["Vouchers verified, awaiting approval", ca(p.vouchers_waiting.checked)],
          ["Vouchers awaiting the CEO", ca(p.vouchers_waiting.dept_approved)],
          ["Vouchers sent to Tally for authorisation", ca(p.vouchers_waiting.for_tally)],
        ]
      : [["Payables", NOT_SET_UP]],
  });
  const rs = c.revenue_share;
  sections.push({
    title: "Doctor revenue share",
    rows: rs
      ? [
          ["Run for the month", rs.run_status === "none" ? "no run yet" : rs.run_status],
          ["Approved on", rs.approved_on ?? "not approved"],
          [`Due by working day ${c.settings.revshare_wd}`, rs.due_on ?? "unknown"],
          ["Liability (approved, not paid)", `AED ${amountText(rs.liability.total)}`],
          ...rs.liability.runs.map((r): [string, string] => [
            `  ${r.month.slice(0, 7)} (${r.status})`,
            `${plural(r.doctors, "doctor")}, AED ${amountText(r.unpaid)}`,
          ]),
        ]
      : [["Revenue share", NOT_SET_UP]],
  });
  const ic = c.invoice_changes;
  sections.push({
    title: "Invoice changes",
    rows: ic.measured
      ? [
          ["Counted from", ic.from],
          ["Unapproved changes in the month", ca(ic.unapproved)],
        ]
      : [["Unapproved changes", "Not measured (no start date set)"]],
  });
  const rc = c.receivables;
  sections.push({
    title: "Insurance receivables",
    rows: rc
      ? [
          ["Open claims", `${rc.open_claims}, AED ${amountText(rc.outstanding)}`],
          ["Over 90 days", ca(rc.over_90)],
          ["Share over 90 days", rc.over_90_pct === null ? "none" : `${rc.over_90_pct}%`],
        ]
      : [["Insurance receivables", NOT_SET_UP]],
  });
  const tt = c.timetable;
  sections.push({
    title: "Close timetable",
    rows: tt
      ? [
          ["Steps done", `${tt.done} of ${tt.tasks}`],
          ["Steps blocked", String(tt.blocked)],
          [
            `Inputs by working day ${tt.inputs_wd}${tt.inputs_due_on ? ` (${tt.inputs_due_on})` : ""}`,
            tt.inputs.total === 0
              ? "none due"
              : `${tt.inputs.on_time} on time, ${tt.inputs.late} late, ${tt.inputs.pending} not yet due`,
          ],
        ]
      : [["Close timetable", NOT_SET_UP]],
  });
  sections.push(insReceivableSection(c));
  sections.push({
    title: "Finance exceptions",
    rows: [
      ["Open", String(c.exceptions.open)],
      ["Oldest", days(c.exceptions.oldest_days)],
      [`Older than ${c.settings.item_max_age_days} days`, String(c.exceptions.over_limit)],
    ],
  });
  return sections;
}
