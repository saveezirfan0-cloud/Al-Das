import { createHash } from "node:crypto";

/**
 * One-way accounting export (pure). Turns the daily aggregates from fin_journal_source into balanced journal lines and a
 * CSV that an accountant imports into Zoho Books, QuickBooks or any ledger that accepts journal CSV. Pulse never reads
 * anything back from the accounting system, and the file carries no patient data (amounts, branches, categories only).
 *
 * Journals (one per day, branch and invoice type, so each can be traced and re-imported without duplicates):
 *   S-<date>-<branch>-<type>   sales:     Dr receivable (invoice totals) / Cr revenue by service category (line net) /
 *                                           Cr VAT output; whatever is left between the invoice total and net + VAT goes to
 *                                           the rounding account (so a rounding difference is visible, never hidden);
 *                                           write-offs and credit notes: Dr their account / Cr receivable
 *   R-<date>-<branch>-<type>   receipts:  Dr the payment-mode account / Cr receivable (amount paid)
 *   F-<date>-<branch>-<type>   refunds:   Dr receivable / Cr the payment-mode account
 * Insurer settlements are NOT booked here: they come from the bank, and the accountant books them from the bank statement.
 * A copay paid on an insurance invoice reduces the insurance receivable here (it is not moved to the patient receivable).
 *
 * Fails closed: if any account the export needs is not in fin_ref_account_map, nothing is produced and the missing keys are
 * listed. The same data always produces the same bytes (stable order, no timestamps), so re-exporting is harmless.
 */

export type AccountMapRow = {
  kind: string;
  key: string;
  account_code: string;
  account_name: string | null;
};

export type JournalSource = {
  sales: Array<{
    date: string;
    branch: string;
    type: string;
    category: string;
    net: number;
    vat: number;
  }>;
  totals: Array<{
    date: string;
    branch: string;
    type: string;
    total: number;
    write_off: number;
    credit_note: number;
  }>;
  receipts: Array<{ date: string; branch: string; type: string; mode: string; paid: number }>;
  refunds: Array<{ date: string; branch: string; type: string; mode: string; refund: number }>;
};

export type JournalLine = {
  journal: string;
  date: string;
  branch: string;
  accountCode: string;
  accountName: string;
  description: string;
  side: "debit" | "credit";
  cents: number;
};

export type ExportResult =
  | {
      ok: true;
      lines: JournalLine[];
      csv: string;
      debitTotal: number;
      creditTotal: number;
      checksum: string;
      rowCount: number;
    }
  | { ok: false; unmapped: Array<{ kind: string; key: string }> };

const c = (n: unknown) => Math.round(Number(n ?? 0) * 100);

export function parseJournalSource(json: unknown): JournalSource {
  const o = (json ?? {}) as Record<string, unknown>;
  const arr = (k: string) => (Array.isArray(o[k]) ? (o[k] as Array<Record<string, unknown>>) : []);
  return {
    sales: arr("sales").map((r) => ({
      date: String(r.date),
      branch: String(r.branch),
      type: String(r.type),
      category: String(r.category),
      net: Number(r.net ?? 0),
      vat: Number(r.vat ?? 0),
    })),
    totals: arr("totals").map((r) => ({
      date: String(r.date),
      branch: String(r.branch),
      type: String(r.type),
      total: Number(r.total ?? 0),
      write_off: Number(r.write_off ?? 0),
      credit_note: Number(r.credit_note ?? 0),
    })),
    receipts: arr("receipts").map((r) => ({
      date: String(r.date),
      branch: String(r.branch),
      type: String(r.type),
      mode: String(r.mode),
      paid: Number(r.paid ?? 0),
    })),
    refunds: arr("refunds").map((r) => ({
      date: String(r.date),
      branch: String(r.branch),
      type: String(r.type),
      mode: String(r.mode),
      refund: Number(r.refund ?? 0),
    })),
  };
}

/** `other` invoice types post to the self-pay receivable (documented limitation). */
const receivableKey = (type: string) => (type === "insurance" ? "insurance" : "self_pay");

/** Every (kind, key) the source needs an account for. */
export function requiredAccounts(src: JournalSource): Array<{ kind: string; key: string }> {
  const need = new Map<string, { kind: string; key: string }>();
  const add = (kind: string, key: string) => need.set(`${kind}\u0000${key}`, { kind, key });
  for (const s of src.sales) {
    if (c(s.net) !== 0) add("revenue", s.category);
    if (c(s.vat) !== 0) add("vat_output", "*");
  }
  for (const t of src.totals) {
    add("receivable", receivableKey(t.type));
    if (c(t.write_off) !== 0) add("writeoff", "*");
    if (c(t.credit_note) !== 0) add("credit_note", "*");
  }
  for (const r of src.receipts)
    if (c(r.paid) !== 0) {
      add("payment_mode", r.mode);
      add("receivable", receivableKey(r.type));
    }
  for (const r of src.refunds)
    if (c(r.refund) !== 0) {
      add("payment_mode", r.mode);
      add("receivable", receivableKey(r.type));
    }
  return [...need.values()].sort((a, b) => (a.kind + a.key).localeCompare(b.kind + b.key));
}

const csvText = (s: string) => {
  // neutralise spreadsheet formulas, then quote when needed
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const money = (cents: number) => (cents / 100).toFixed(2);

export const CSV_HEADER = [
  "Journal",
  "Date",
  "Branch",
  "Account code",
  "Account name",
  "Description",
  "Debit",
  "Credit",
  "Currency",
  "Status",
];

export function buildJournal(
  source: JournalSource,
  accounts: readonly AccountMapRow[],
  opts: { status: "provisional" | "final"; currency?: string },
): ExportResult {
  const map = new Map(accounts.map((a) => [`${a.kind}\u0000${a.key}`, a]));
  const unmapped = requiredAccounts(source).filter((r) => !map.has(`${r.kind}\u0000${r.key}`));
  if (unmapped.length > 0) return { ok: false, unmapped };
  const account = (kind: string, key: string) => map.get(`${kind}\u0000${key}`)!;

  const lines: JournalLine[] = [];
  const push = (
    journal: string,
    date: string,
    branch: string,
    kind: string,
    key: string,
    side: "debit" | "credit",
    amount: number,
    description: string,
  ) => {
    if (amount === 0) return;
    const a = account(kind, key);
    // a negative amount is the opposite side
    const flipped = amount < 0;
    lines.push({
      journal,
      date,
      branch,
      accountCode: a.account_code,
      accountName: a.account_name ?? "",
      description,
      side: flipped ? (side === "debit" ? "credit" : "debit") : side,
      cents: Math.abs(amount),
    });
  };

  // sales, grouped per day / branch / type
  const groups = new Map<string, { date: string; branch: string; type: string }>();
  const gkey = (r: { date: string; branch: string; type: string }) =>
    `${r.date}|${r.branch}|${r.type}`;
  for (const s of source.sales)
    groups.set(gkey(s), { date: s.date, branch: s.branch, type: s.type });
  for (const t of source.totals)
    groups.set(gkey(t), { date: t.date, branch: t.branch, type: t.type });
  for (const g of [...groups.values()].sort((a, b) => gkey(a).localeCompare(gkey(b)))) {
    const journal = `S-${g.date.replaceAll("-", "")}-${g.branch}-${g.type}`;
    const desc = `Sales ${g.type.replace("_", " ")} ${g.date} branch ${g.branch}`;
    const sales = source.sales.filter((s) => gkey(s) === gkey(g));
    const total = source.totals.find((t) => gkey(t) === gkey(g));
    let credits = 0;
    for (const s of sales.sort((a, b) => a.category.localeCompare(b.category))) {
      push(
        journal,
        g.date,
        g.branch,
        "revenue",
        s.category,
        "credit",
        c(s.net),
        `${desc} (${s.category})`,
      );
      credits += c(s.net);
    }
    const vat = sales.reduce((a, s) => a + c(s.vat), 0);
    push(journal, g.date, g.branch, "vat_output", "*", "credit", vat, `${desc} VAT`);
    credits += vat;
    const debit = total ? c(total.total) : 0;
    push(journal, g.date, g.branch, "receivable", receivableKey(g.type), "debit", debit, desc);
    const diff = debit - credits; // > 0: more debited than credited
    if (diff !== 0) {
      // the rounding account is needed only when there is a difference
      if (!map.has("rounding\u0000*"))
        return { ok: false, unmapped: [{ kind: "rounding", key: "*" }] };
      push(
        journal,
        g.date,
        g.branch,
        "rounding",
        "*",
        "credit",
        diff,
        `${desc} rounding difference`,
      );
    }
    if (total && c(total.write_off) !== 0) {
      push(
        journal,
        g.date,
        g.branch,
        "writeoff",
        "*",
        "debit",
        c(total.write_off),
        `${desc} write-off`,
      );
      push(
        journal,
        g.date,
        g.branch,
        "receivable",
        receivableKey(g.type),
        "credit",
        c(total.write_off),
        `${desc} write-off`,
      );
    }
    if (total && c(total.credit_note) !== 0) {
      push(
        journal,
        g.date,
        g.branch,
        "credit_note",
        "*",
        "debit",
        c(total.credit_note),
        `${desc} credit notes`,
      );
      push(
        journal,
        g.date,
        g.branch,
        "receivable",
        receivableKey(g.type),
        "credit",
        c(total.credit_note),
        `${desc} credit notes`,
      );
    }
  }

  const byKey = <T extends { date: string; branch: string; type: string; mode: string }>(
    rows: T[],
  ) =>
    [...rows].sort((a, b) =>
      `${a.date}|${a.branch}|${a.type}|${a.mode}`.localeCompare(
        `${b.date}|${b.branch}|${b.type}|${b.mode}`,
      ),
    );
  for (const r of byKey(source.receipts)) {
    const journal = `R-${r.date.replaceAll("-", "")}-${r.branch}-${r.type}`;
    const desc = `Receipts ${r.type.replace("_", " ")} ${r.date} branch ${r.branch} (${r.mode})`;
    push(journal, r.date, r.branch, "payment_mode", r.mode, "debit", c(r.paid), desc);
    push(journal, r.date, r.branch, "receivable", receivableKey(r.type), "credit", c(r.paid), desc);
  }
  for (const r of byKey(source.refunds)) {
    const journal = `F-${r.date.replaceAll("-", "")}-${r.branch}-${r.type}`;
    const desc = `Refunds ${r.type.replace("_", " ")} ${r.date} branch ${r.branch} (${r.mode})`;
    push(
      journal,
      r.date,
      r.branch,
      "receivable",
      receivableKey(r.type),
      "debit",
      c(r.refund),
      desc,
    );
    push(journal, r.date, r.branch, "payment_mode", r.mode, "credit", c(r.refund), desc);
  }

  const sum = (side: "debit" | "credit") =>
    lines.filter((l) => l.side === side).reduce((a, l) => a + l.cents, 0);
  const debitTotal = sum("debit");
  const creditTotal = sum("credit");
  // each journal must balance by itself, not just the file
  const perJournal = new Map<string, number>();
  for (const l of lines)
    perJournal.set(
      l.journal,
      (perJournal.get(l.journal) ?? 0) + (l.side === "debit" ? l.cents : -l.cents),
    );
  if (debitTotal !== creditTotal || [...perJournal.values()].some((v) => v !== 0))
    throw new Error("journal does not balance"); // a programming error, never user data

  const currency = opts.currency ?? "AED";
  const status = opts.status === "final" ? "FINAL" : "PROVISIONAL";
  const rows = lines.map((l) =>
    [
      l.journal,
      l.date,
      l.branch,
      l.accountCode,
      l.accountName,
      l.description,
      l.side === "debit" ? money(l.cents) : "",
      l.side === "credit" ? money(l.cents) : "",
      currency,
      status,
    ]
      .map((v) => csvText(String(v)))
      .join(","),
  );
  const csv = [CSV_HEADER.join(","), ...rows].join("\r\n") + "\r\n";
  return {
    ok: true,
    lines,
    csv,
    debitTotal: debitTotal / 100,
    creditTotal: creditTotal / 100,
    checksum: createHash("sha256").update(csv).digest("hex"),
    rowCount: lines.length,
  };
}
