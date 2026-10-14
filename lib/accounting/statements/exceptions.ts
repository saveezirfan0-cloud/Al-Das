import { NATURE_LABELS, type AccountNature } from "@/lib/accounting/accounts";
import type { ReportTable } from "@/lib/accounting/statements/report";

/**
 * Exception reports in Tally's spirit (pure shaping of acc_statement_exceptions): journals posted in the adjustment
 * period or after their month was closed, cash and bank ledgers below zero on a day, ledgers whose balance is opposite to
 * their nature (contra accounts such as accumulated depreciation appear by design), suspense not cleared, large manual
 * journals (threshold from Settings) and lines missing a branch or cost centre the ledger asks for.
 */

export type ExceptionsData = {
  from: string;
  to: string;
  large_journal_amount: number;
  provisional: boolean;
  late_postings: Array<{
    journal_id: string;
    number: string;
    date: string;
    voucher_type: string;
    total: number;
    source_kind: string | null;
    is_adjustment: boolean;
    period_status: string;
    posted_at: string;
    closed_at: string | null;
  }>;
  negative_cash: Array<{
    account_id: string;
    code: string;
    name: string;
    date: string;
    balance: number;
  }>;
  opposite_balances: Array<{
    account_id: string;
    code: string;
    name: string;
    nature: AccountNature;
    balance: number;
  }>;
  suspense: Array<{ account_id: string; code: string; name: string; balance: number }>;
  large_manual: Array<{
    journal_id: string;
    number: string;
    date: string;
    voucher_type: string;
    total: number;
    narration: string;
  }>;
  missing_dimension: Array<{
    line_id: string;
    journal_id: string;
    number: string;
    date: string;
    code: string;
    name: string;
    no_branch: boolean;
    no_cost_centre: boolean;
    amount: number;
  }>;
};

export function exceptionCount(d: ExceptionsData): number {
  return (
    d.late_postings.length +
    d.negative_cash.length +
    d.opposite_balances.length +
    d.suspense.length +
    d.large_manual.length +
    d.missing_dimension.length
  );
}

export function buildExceptions(
  d: ExceptionsData,
  opts: {
    journalHref?: (id: string) => string | null;
    ledgerHref?: (accountId: string) => string | null;
  } = {},
): ReportTable[] {
  const j = (id: string) => (opts.journalHref ? opts.journalHref(id) : null);
  const l = (id: string) => (opts.ledgerHref ? opts.ledgerHref(id) : null);
  return [
    {
      title: "Journals posted in the adjustment period or after their month was closed",
      labelHeader: "Journal",
      columns: ["Date", "Type", "Why", "Total"],
      formats: ["text", "text", "text", "money"],
      rows: d.late_postings.map((x) => ({
        label: x.number,
        depth: 0,
        kind: "ledger",
        values: [
          x.date,
          x.voucher_type,
          x.is_adjustment
            ? "Adjustment period"
            : `Posted after the close (period ${x.period_status})`,
          Number(x.total),
        ],
        href: j(x.journal_id),
        flag: "warning",
      })),
      empty: "None.",
    },
    {
      title: "Cash and bank ledgers below zero",
      labelHeader: "Ledger",
      columns: ["Day", "Balance"],
      formats: ["text", "money"],
      rows: d.negative_cash.map((x) => ({
        label: `${x.code} ${x.name}`,
        depth: 0,
        kind: "ledger",
        values: [x.date, Number(x.balance)],
        href: l(x.account_id),
        flag: "warning",
      })),
      empty: "None.",
    },
    {
      title:
        "Balances opposite to the account's nature (contra accounts such as accumulated depreciation are expected)",
      labelHeader: "Ledger",
      columns: ["Nature", "Balance (debit +, credit -)"],
      formats: ["text", "money"],
      rows: d.opposite_balances.map((x) => ({
        label: `${x.code} ${x.name}`,
        depth: 0,
        kind: "ledger",
        values: [NATURE_LABELS[x.nature] ?? x.nature, Number(x.balance)],
        href: l(x.account_id),
        flag: "warning",
      })),
      empty: "None.",
    },
    {
      title: "Suspense not cleared",
      labelHeader: "Ledger",
      columns: ["Balance (debit +, credit -)"],
      rows: d.suspense.map((x) => ({
        label: `${x.code} ${x.name}`,
        depth: 0,
        kind: "ledger",
        values: [Number(x.balance)],
        href: l(x.account_id),
        flag: "warning",
      })),
      empty: "None.",
    },
    {
      title: `Manual journals of AED ${Number(d.large_journal_amount).toLocaleString("en-GB")} or more`,
      labelHeader: "Journal",
      columns: ["Date", "Type", "Narration", "Total"],
      formats: ["text", "text", "text", "money"],
      rows: d.large_manual.map((x) => ({
        label: x.number,
        depth: 0,
        kind: "ledger",
        values: [x.date, x.voucher_type, x.narration, Number(x.total)],
        href: j(x.journal_id),
      })),
      empty: "None.",
    },
    {
      title: "Lines without the branch or cost centre their ledger asks for",
      labelHeader: "Journal",
      columns: ["Date", "Ledger", "Missing", "Amount"],
      formats: ["text", "text", "text", "money"],
      rows: d.missing_dimension.map((x) => ({
        label: x.number,
        depth: 0,
        kind: "ledger",
        values: [
          x.date,
          `${x.code} ${x.name}`,
          [x.no_branch ? "branch" : null, x.no_cost_centre ? "cost centre" : null]
            .filter(Boolean)
            .join(", "),
          Number(x.amount),
        ],
        href: j(x.journal_id),
        flag: "warning",
      })),
      empty: "None.",
    },
  ];
}
