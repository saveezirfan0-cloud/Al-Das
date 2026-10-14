import { selectClass } from "@/components/finance/forms";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { STATUS_LABELS, type JournalStatus } from "@/lib/accounting/journal";
import { drCr } from "@/lib/accounting/reports";
import { money } from "@/lib/finance/format";

/** Small display pieces shared by the Accounting pages (server components, no client code). */

export function JournalStatusBadge({
  status,
  waiting,
}: {
  status: JournalStatus;
  waiting?: boolean;
}) {
  if (status === "draft" && waiting) return <Badge variant="warning">Waiting to post</Badge>;
  const variant = status === "posted" ? "success" : status === "reversed" ? "secondary" : "outline";
  return <Badge variant={variant}>{STATUS_LABELS[status]}</Badge>;
}

/** 1,200.00 Dr / 300.00 Cr. */
export function Balance({ value }: { value: number }) {
  const b = drCr(value);
  return (
    <span className="tabular-nums">
      {money(b.amount)}
      {b.side && <span className="text-muted-foreground ml-1 text-xs">{b.side}</span>}
    </span>
  );
}

export function Amount({ value }: { value: number }) {
  return <span className="tabular-nums">{value ? money(value) : ""}</span>;
}

/**
 * Phase B: the branch filter of a ledger report (a GET field named `branch`). Options are finance branch codes labelled
 * with the clinical branch using each (lib/branches/codes.ts). Shown only when the organisation has more than one.
 */
export function BranchCodeSelect({
  options,
  value,
}: {
  options: ReadonlyArray<{ code: string; label: string }>;
  value: string | null;
}) {
  if (options.length < 2) return null;
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">Branch</span>
      <select name="branch" defaultValue={value ?? ""} className={`${selectClass} w-52`}>
        <option value="">All branches</option>
        {options.map((o) => (
          <option key={o.code} value={o.code}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** What a branch view of the ledger means, shown above the figures. */
export const BRANCH_VIEW_NOTE =
  "Branch view: only journal lines that name this branch are counted. Bank, VAT, receivable and other control lines often name no branch, so the figures need not balance.";

/** A GET form with a from / to range and any hidden fields to keep (filters, the account). */
export function RangeForm({
  from,
  to,
  hidden = {},
  children,
}: {
  from: string;
  to: string;
  hidden?: Record<string, string>;
  children?: React.ReactNode;
}) {
  return (
    <form className="flex flex-wrap items-end gap-2" method="get">
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {children}
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">From</span>
        <Input type="date" name="from" defaultValue={from} className="w-40" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">To</span>
        <Input type="date" name="to" defaultValue={to} className="w-40" />
      </label>
      <Button type="submit" variant="secondary">
        Show
      </Button>
    </form>
  );
}

/** A date from the query string, or the fallback. */
export function dateParam(raw: string | undefined, fallback: string): string {
  const v = (raw ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
    ? v
    : fallback;
}
