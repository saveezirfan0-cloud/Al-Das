import {
  cents,
  dateLabel,
  fromCents,
  type ReportRow,
  type ReportTable,
} from "@/lib/accounting/statements/report";

/**
 * The FTA VAT 201 return as a working paper (pure). acc_vat_return places every line with a tax code in a box (see the
 * migration for the rules) and sums them; this lays the boxes out as on the form, with the checks (VAT booked against
 * amount x rate, lines using the default emirate, blocked and out-of-scope amounts, lines to review) and the list of
 * lines without a tax code. Pulse never files anything.
 */

export const VAT_BOX_LABELS: Record<string, string> = {
  "1a": "Standard-rated supplies in Abu Dhabi",
  "1b": "Standard-rated supplies in Dubai",
  "1c": "Standard-rated supplies in Sharjah",
  "1d": "Standard-rated supplies in Ajman",
  "1e": "Standard-rated supplies in Umm Al Quwain",
  "1f": "Standard-rated supplies in Ras Al Khaimah",
  "1g": "Standard-rated supplies in Fujairah",
  "2": "Tax refunds provided to tourists (normally zero for the clinic)",
  "3": "Supplies subject to the reverse charge",
  "4": "Zero-rated supplies",
  "5": "Exempt supplies",
  "6": "Goods imported into the UAE (normally zero)",
  "7": "Adjustments to goods imported into the UAE (normally zero)",
  "8": "Totals",
  "9": "Standard-rated expenses",
  "10": "Supplies subject to the reverse charge",
  "11": "Totals",
  "12": "Total value of due tax for the period",
  "13": "Total value of recoverable tax for the period",
  "14": "Payable tax for the period",
  blocked: "Blocked input VAT (excluded from box 9)",
  out_of_scope: "Out-of-scope supplies (not on the return)",
  not_in_return: "Zero-rated, exempt or out-of-scope purchases (not on the return)",
  review: "Tax code on an unexpected account: review",
};

export const OUTPUT_BOXES = [
  "1a",
  "1b",
  "1c",
  "1d",
  "1e",
  "1f",
  "1g",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
] as const;
export const INPUT_BOXES = ["9", "10"] as const;
export const DRILL_BOXES = [
  ...OUTPUT_BOXES,
  ...INPUT_BOXES,
  "blocked",
  "out_of_scope",
  "not_in_return",
  "review",
] as const;

export type VatBox = {
  box: string;
  amount: number;
  vat: number;
  expected_vat: number;
  adjustment: number;
  lines: number;
  defaulted_emirate: number;
};

export type VatLine = {
  box: string;
  line_id: string;
  journal_id: string;
  number: string;
  date: string;
  account_code: string;
  account_name: string;
  branch_code: string | null;
  tax_code: string | null;
  emirate: string;
  emirate_defaulted: boolean;
  amount: number;
  vat: number;
};

export type VatData = {
  from: string;
  to: string;
  entity_id: string;
  entity_name: string;
  trn: string | null;
  default_emirate: string;
  provisional: boolean;
  boxes: VatBox[];
  totals: {
    box8_amount: number;
    box8_vat: number;
    box11_amount: number;
    box11_vat: number;
    box12: number;
    box13: number;
    box14: number;
  };
  lines: VatLine[];
  lines_truncated: boolean;
  missing_tax_code: Array<{
    line_id: string;
    journal_id: string;
    number: string;
    date: string;
    account_code: string;
    account_name: string;
    branch_code: string | null;
    debit: number;
    credit: number;
  }>;
  missing_truncated: boolean;
};

/** Box totals recomputed from the boxes (the same sums as the database's, used by the parity test and the page). */
export function vatTotals(boxes: readonly VatBox[]): VatData["totals"] {
  const get = (b: string) => boxes.find((x) => x.box === b);
  const sum = (list: readonly string[], f: "amount" | "vat") =>
    list.reduce((s, b) => s + cents(get(b)?.[f] ?? 0), 0);
  const outAmount = sum(OUTPUT_BOXES, "amount");
  const outVat = sum(["1a", "1b", "1c", "1d", "1e", "1f", "1g", "2", "3", "6", "7"], "vat");
  const inAmount = sum(INPUT_BOXES, "amount");
  const inVat = sum(INPUT_BOXES, "vat");
  return {
    box8_amount: fromCents(outAmount),
    box8_vat: fromCents(outVat),
    box11_amount: fromCents(inAmount),
    box11_vat: fromCents(inVat),
    box12: fromCents(outVat),
    box13: fromCents(inVat),
    box14: fromCents(outVat - inVat),
  };
}

/**
 * VAT periods ending on or before the period holding `today`, newest first: monthly or quarterly, quarters starting in
 * the anchor month (1 = Jan / Apr / Jul / Oct, 2 = Feb / May / Aug / Nov, ...).
 */
export function vatPeriods(
  today: string,
  months: 1 | 3,
  anchorMonth: number,
  count = 8,
): Array<{ from: string; to: string; label: string }> {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const anchor = ((((anchorMonth - 1) % months) + months) % months) + 1; // the first period-start month in a year
  // index of the period holding today: months since Jan of year 0 shifted by the anchor
  const abs = y * 12 + (m - 1);
  const startAbs = abs - ((((abs - (anchor - 1)) % months) + months) % months);
  const out: Array<{ from: string; to: string; label: string }> = [];
  for (let i = 0; i < count; i++) {
    const s = startAbs - i * months;
    const sy = Math.floor(s / 12);
    const sm = (s % 12) + 1;
    const e = s + months - 1;
    const ey = Math.floor(e / 12);
    const em = (e % 12) + 1;
    const from = `${sy}-${String(sm).padStart(2, "0")}-01`;
    const last = new Date(Date.UTC(ey, em, 0)).getUTCDate();
    const to = `${ey}-${String(em).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
    out.push({ from, to, label: `${dateLabel(from)} to ${dateLabel(to)}` });
  }
  return out;
}

export type VatReturn = {
  tables: ReportTable[];
  totals: VatData["totals"];
  checks: { vatMismatch: boolean; defaultedLines: number; missing: number; review: number };
};

export function buildVatReturn(
  data: VatData,
  opts: {
    journalHref?: (journalId: string) => string | null;
    boxHref?: (box: string) => string | null;
  } = {},
): VatReturn {
  const get = (b: string): VatBox =>
    data.boxes.find((x) => x.box === b) ?? {
      box: b,
      amount: 0,
      vat: 0,
      expected_vat: 0,
      adjustment: 0,
      lines: 0,
      defaulted_emirate: 0,
    };
  const totals = vatTotals(data.boxes);
  const boxRow = (b: string, withVat = true): ReportRow => {
    const x = get(b);
    return {
      label: VAT_BOX_LABELS[b],
      code: b,
      depth: 0,
      kind: "ledger",
      values: withVat ? [Number(x.amount), Number(x.vat), 0] : [Number(x.amount), null, 0],
      href: x.lines > 0 && opts.boxHref ? opts.boxHref(b) : null,
      flag: x.defaulted_emirate > 0 ? "warning" : null,
    };
  };
  const output: ReportTable = {
    title: "VAT on sales and all other outputs",
    labelHeader: "Box",
    columns: ["Amount (AED)", "VAT amount (AED)", "Adjustment (AED)"],
    rows: [
      ...OUTPUT_BOXES.map((b) => boxRow(b, !["4", "5"].includes(b))),
      {
        label: VAT_BOX_LABELS["8"],
        code: "8",
        depth: 0,
        kind: "total",
        values: [totals.box8_amount, totals.box8_vat, 0],
      },
    ],
  };
  const input: ReportTable = {
    title: "VAT on expenses and all other inputs",
    labelHeader: "Box",
    columns: ["Amount (AED)", "Recoverable VAT (AED)", "Adjustment (AED)"],
    rows: [
      boxRow("9"),
      boxRow("10"),
      {
        label: VAT_BOX_LABELS["11"],
        code: "11",
        depth: 0,
        kind: "total",
        values: [totals.box11_amount, totals.box11_vat, 0],
      },
    ],
  };
  const net: ReportTable = {
    title: "Net VAT due",
    labelHeader: "Box",
    columns: ["AED"],
    rows: [
      { label: VAT_BOX_LABELS["12"], code: "12", depth: 0, kind: "ledger", values: [totals.box12] },
      { label: VAT_BOX_LABELS["13"], code: "13", depth: 0, kind: "ledger", values: [totals.box13] },
      {
        label: totals.box14 < 0 ? `${VAT_BOX_LABELS["14"]} (refundable)` : VAT_BOX_LABELS["14"],
        code: "14",
        depth: 0,
        kind: "total",
        values: [totals.box14],
      },
    ],
  };
  const vatBoxes = ["1a", "1b", "1c", "1d", "1e", "1f", "1g", "3", "9", "10"];
  let vatMismatch = false;
  const checkRows: ReportRow[] = vatBoxes
    .map((b) => get(b))
    .filter((x) => x.lines > 0)
    .map((x) => {
      const d = cents(x.vat) - cents(x.expected_vat);
      if (d !== 0) vatMismatch = true;
      return {
        label: `Box ${x.box}: VAT booked against amount x rate`,
        code: x.box,
        depth: 0,
        kind: "ledger",
        values: [Number(x.expected_vat), Number(x.vat), fromCents(d), x.defaulted_emirate],
        flag: d !== 0 || x.defaulted_emirate > 0 ? "warning" : null,
      };
    });
  for (const b of ["blocked", "out_of_scope", "not_in_return", "review"]) {
    const x = get(b);
    if (x.lines > 0)
      checkRows.push({
        label: VAT_BOX_LABELS[b],
        code: b,
        depth: 0,
        kind: "ledger",
        values: [Number(x.amount), Number(x.vat), null, null],
        href: opts.boxHref ? opts.boxHref(b) : null,
        flag: b === "review" ? "warning" : null,
      });
  }
  const checks: ReportTable = {
    title: "Checks",
    labelHeader: "Check",
    columns: ["Expected VAT / amount", "VAT booked", "Difference", "Lines on the default emirate"],
    formats: ["money", "money", "money", "number"],
    rows: checkRows,
    empty: "Nothing to check.",
  };
  const missing: ReportTable = {
    title: `Lines without a tax code${data.missing_truncated ? " (first 1,000)" : ""}`,
    labelHeader: "Account",
    columns: ["Date", "Journal", "Branch", "Debit", "Credit"],
    formats: ["text", "text", "text", "money", "money"],
    rows: data.missing_tax_code.map((m) => ({
      label: `${m.account_code} ${m.account_name}`,
      depth: 0,
      kind: "ledger",
      values: [m.date, m.number, m.branch_code ?? "", Number(m.debit), Number(m.credit)],
      href: opts.journalHref ? opts.journalHref(m.journal_id) : null,
      flag: "warning",
    })),
    empty: "Every income, expense and VAT line in the period has a tax code.",
  };
  const support: ReportTable = {
    title: `Supporting lines${data.lines_truncated ? " (first 5,000)" : ""}`,
    labelHeader: "Box",
    columns: ["Date", "Journal", "Account", "Branch", "Tax code", "Emirate", "Amount", "VAT"],
    formats: ["text", "text", "text", "text", "text", "text", "money", "money"],
    rows: data.lines.map((l) => ({
      label: l.box,
      depth: 0,
      kind: "ledger",
      values: [
        l.date,
        l.number,
        `${l.account_code} ${l.account_name}`,
        l.branch_code ?? "",
        l.tax_code ?? "",
        l.emirate_defaulted ? `${l.emirate} (default)` : l.emirate,
        Number(l.amount),
        Number(l.vat),
      ],
      href: opts.journalHref ? opts.journalHref(l.journal_id) : null,
    })),
    empty: "No lines with a tax code in this period.",
    pdf: false,
  };
  return {
    tables: [output, input, net, checks, missing, support],
    totals,
    checks: {
      vatMismatch,
      defaultedLines: data.boxes.reduce(
        (s, b) => s + (/^1[a-g]$/.test(b.box) ? b.defaulted_emirate : 0),
        0,
      ),
      missing: data.missing_tax_code.length,
      review: get("review").lines,
    },
  };
}

/** The supporting lines of one box, as a table (the page's drill-down). */
export function vatBoxLines(
  data: VatData,
  box: string,
  journalHref?: (journalId: string) => string | null,
): ReportTable {
  const t = buildVatReturn(data, { journalHref }).tables[5];
  return {
    ...t,
    title: `Box ${box}: ${VAT_BOX_LABELS[box] ?? box}`,
    rows: t.rows.filter((r) => r.label === box),
  };
}
