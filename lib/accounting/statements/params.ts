import { rangeProblem } from "@/lib/accounting/reports";
import type { PlDimension } from "@/lib/accounting/statements/profit-loss";

/**
 * Query-string options shared by the statement pages and their Excel / PDF route (pure), so both read a link the same
 * way. Anything malformed falls back to the default (the fiscal year to date) and says so.
 */

export const STATEMENT_REPORTS = [
  "profit-and-loss",
  "balance-sheet",
  "cash-flow",
  "budget-vs-actual",
  "vat-return",
  "ratios",
  "exceptions",
  "corporate-tax",
] as const;
export type StatementReport = (typeof STATEMENT_REPORTS)[number];

export const STATEMENT_TITLES: Record<StatementReport, string> = {
  "profit-and-loss": "Profit and loss",
  "balance-sheet": "Balance sheet",
  "cash-flow": "Cash flow",
  "budget-vs-actual": "Budget against actual",
  "vat-return": "VAT return (VAT 201)",
  ratios: "Ratios",
  exceptions: "Exceptions",
  "corporate-tax": "Corporate tax bridge",
};

export type StatementParams = {
  entity: string | null;
  from: string;
  to: string;
  includeAdjustment: boolean;
  groupsOnly: boolean;
  dimension: PlDimension;
  compare: "none" | "previous" | "last_year";
  budget: string | null;
  branch: string | null;
  department: string | null;
  box: string | null;
  otherAddBacks: number;
  otherDeductions: number;
  /** set when the typed range was refused and the default used instead */
  problem: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const one = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? (v[0] ?? "") : (v ?? "");

function amountParam(v: string): number {
  const t = v.replace(/,/g, "").trim();
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(t)) return 0;
  return Number(t);
}

export function parseStatementParams(
  sp: Record<string, string | string[] | undefined> | URLSearchParams,
  defaults: { from: string; to: string },
): StatementParams {
  const get = (k: string) =>
    sp instanceof URLSearchParams
      ? (sp.get(k) ?? "")
      : one((sp as Record<string, string | string[] | undefined>)[k]);
  let from = get("from").slice(0, 10);
  let to = get("to").slice(0, 10);
  if (!DATE.test(from)) from = defaults.from;
  if (!DATE.test(to)) to = defaults.to;
  const problem = rangeProblem(from, to);
  if (problem) {
    from = defaults.from;
    to = defaults.to;
  }
  const dim = get("dim");
  const compare = get("compare");
  const text = (k: string, max: number) => {
    const v = get(k).trim();
    return v && v.length <= max && /^[\p{L}\p{N} ._&/-]+$/u.test(v) ? v : null;
  };
  return {
    entity: UUID.test(get("entity")) ? get("entity") : null,
    from,
    to,
    includeAdjustment: get("adj") !== "0",
    groupsOnly: get("view") === "groups",
    dimension: (["month", "branch", "department", "doctor"].includes(dim)
      ? dim
      : "none") as PlDimension,
    compare: compare === "previous" || compare === "last_year" ? compare : "none",
    budget: UUID.test(get("budget")) ? get("budget") : null,
    branch: text("branch", 20),
    department: text("department", 60),
    box: /^(1[a-g]|[2-9]|1[0-4]|blocked|out_of_scope|not_in_return|review)$/.test(get("box"))
      ? get("box")
      : null,
    otherAddBacks: amountParam(get("add")),
    otherDeductions: amountParam(get("ded")),
    problem,
  };
}

/** The query string for the same view (used by the download links), without the drill-down box. */
export function statementQuery(p: StatementParams): string {
  const q = new URLSearchParams();
  q.set("from", p.from);
  q.set("to", p.to);
  if (p.entity) q.set("entity", p.entity);
  if (!p.includeAdjustment) q.set("adj", "0");
  if (p.groupsOnly) q.set("view", "groups");
  if (p.dimension !== "none") q.set("dim", p.dimension);
  if (p.compare !== "none") q.set("compare", p.compare);
  if (p.budget) q.set("budget", p.budget);
  if (p.branch) q.set("branch", p.branch);
  if (p.department) q.set("department", p.department);
  if (p.otherAddBacks) q.set("add", String(p.otherAddBacks));
  if (p.otherDeductions) q.set("ded", String(p.otherDeductions));
  return q.toString();
}
