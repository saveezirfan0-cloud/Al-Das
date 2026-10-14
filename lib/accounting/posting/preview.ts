/**
 * The parallel-run comparison (Phase 22D, pure): acc_posting_preview_report rows (account x month: Pulse's preview,
 * the ledger, the difference) grouped by account for the Posting preview page. A difference under one fils is none.
 */

export type PreviewReportRow = {
  account_id: string;
  code: string;
  name: string;
  month: string;
  preview: number;
  ledger: number;
  difference: number;
};

export type PreviewAccount = {
  code: string;
  name: string;
  months: Array<{ month: string; preview: number; ledger: number; difference: number }>;
};

const cents = (n: number) => Math.round(Number(n) * 100);

export function comparePreview(
  rows: readonly PreviewReportRow[],
  opts: { onlyDifferences: boolean },
): { months: string[]; accounts: PreviewAccount[]; totals: { accountsWithDifference: number } } {
  const months = [...new Set(rows.map((r) => r.month))].sort();
  const byAccount = new Map<string, PreviewAccount>();
  const differing = new Set<string>();
  for (const r of [...rows].sort(
    (a, b) => a.code.localeCompare(b.code) || a.month.localeCompare(b.month),
  )) {
    const diff = cents(r.preview) - cents(r.ledger);
    if (diff !== 0) differing.add(r.code);
    const a = byAccount.get(r.code) ?? { code: r.code, name: r.name, months: [] };
    a.months.push({
      month: r.month,
      preview: cents(r.preview) / 100,
      ledger: cents(r.ledger) / 100,
      difference: diff / 100,
    });
    byAccount.set(r.code, a);
  }
  const accounts = [...byAccount.values()]
    .filter((a) => !opts.onlyDifferences || differing.has(a.code))
    .map((a) =>
      opts.onlyDifferences ? { ...a, months: a.months.filter((m) => m.difference !== 0) } : a,
    );
  return { months, accounts, totals: { accountsWithDifference: differing.size } };
}
