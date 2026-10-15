import Link from "next/link";

import { selectClass } from "@/components/finance/forms";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Term } from "@/components/shell/term";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { EntityView } from "@/lib/accounting/accounting-server";
import {
  formatValue,
  type ColumnFormat,
  type ReportDoc,
  type ReportTable,
} from "@/lib/accounting/statements/report";

/**
 * Renders a statement (ReportDoc) exactly as the Excel and PDF exports do: the Provisional label, the working-paper
 * banner, warnings, the tables (groups indented and bold, drill-down links, highlighted lines) and the notes. Server
 * component; print-friendly (the shell hides itself on print).
 */

export function ReportStatus({ doc }: { doc: ReportDoc }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {doc.provisional ? (
          <Badge variant="warning">
            <Term k="provisional" />
          </Badge>
        ) : (
          <Badge variant="success">Final: every month in range is closed</Badge>
        )}
        <span className="text-muted-foreground text-sm">{doc.subtitle}</span>
      </div>
      {doc.provisional && (
        <p className="text-muted-foreground text-xs">
          Provisional until every month in the range is closed or locked (Accounting, Periods);
          figures can still change.
        </p>
      )}
      {doc.workingPaper && (
        <Alert>
          <AlertDescription className="font-medium">{doc.workingPaper}</AlertDescription>
        </Alert>
      )}
      {doc.warnings.map((w) => (
        <Alert key={w} variant="destructive">
          <AlertDescription>{w}</AlertDescription>
        </Alert>
      ))}
    </div>
  );
}

export function ReportTableView({ table, id }: { table: ReportTable; id?: string }) {
  const fmt = (i: number, rowFormat?: ColumnFormat): ColumnFormat =>
    rowFormat ?? table.formats?.[i] ?? "money";
  return (
    <Card id={id}>
      {table.title && (
        <CardHeader>
          <CardTitle className="text-base">{table.title}</CardTitle>
        </CardHeader>
      )}
      <CardContent className={`overflow-x-auto ${table.title ? "" : "pt-6"}`}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{table.labelHeader ?? ""}</TableHead>
              {table.columns.map((c) => (
                <TableHead key={c} className="text-right whitespace-nowrap">
                  {c}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {table.rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={table.columns.length + 1}
                  className="text-muted-foreground text-sm"
                >
                  {table.empty ?? "Nothing to show."}
                </TableCell>
              </TableRow>
            )}
            {table.rows.map((r, i) => {
              const strong = r.kind !== "ledger" && r.kind !== "note";
              const tone =
                r.flag === "adverse"
                  ? "bg-red-50 dark:bg-red-950/40"
                  : r.flag === "warning"
                    ? "bg-amber-50 dark:bg-amber-950/40"
                    : r.kind === "total"
                      ? "border-t-2"
                      : "";
              return (
                <TableRow
                  key={`${r.code ?? ""}-${r.label}-${i}`}
                  className={`${strong ? "font-medium" : ""} ${tone}`}
                >
                  <TableCell className={r.kind === "heading" ? "pt-4 text-base" : ""}>
                    <span style={{ paddingLeft: `${r.depth * 1.25}rem` }}>
                      {r.code && r.kind !== "heading" && (
                        <span className="text-muted-foreground mr-2 font-mono text-xs">
                          {r.code}
                        </span>
                      )}
                      {r.href ? (
                        <Link href={r.href} className="underline-offset-2 hover:underline">
                          {r.label}
                        </Link>
                      ) : (
                        r.label
                      )}
                      {r.flag === "adverse" && (
                        <Badge variant="destructive" className="ml-2">
                          Worse than budget
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  {table.columns.map((c, ci) => (
                    <TableCell key={c} className="text-right whitespace-nowrap tabular-nums">
                      {formatValue(r.values[ci] ?? null, fmt(ci, r.format))}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function ReportView({ doc, skipStatus }: { doc: ReportDoc; skipStatus?: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      {!skipStatus && <ReportStatus doc={doc} />}
      {doc.tables.map((t, i) => (
        <ReportTableView
          key={`${t.title ?? "t"}-${i}`}
          table={t}
          id={t.title?.startsWith("Box ") ? "box" : undefined}
        />
      ))}
      {doc.notes.length > 0 && (
        <ul className="text-muted-foreground list-disc pl-5 text-xs">
          {doc.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Excel and PDF of exactly what is on screen. */
export function DownloadButtons({ report, query }: { report: string; query: string }) {
  const base = `/api/accounting/reports/${report}?${query}`;
  return (
    <div className="flex gap-2 print:hidden">
      <Button asChild variant="outline" size="sm">
        <a href={`${base}&format=xlsx`}>Excel</a>
      </Button>
      <Button asChild variant="outline" size="sm">
        <a href={`${base}&format=pdf`}>PDF</a>
      </Button>
    </div>
  );
}

/** The usual filter form: entity (when there are several), dates, the adjustment-period toggle and extras. */
export function StatementFilters({
  entities,
  entity,
  from,
  to,
  showFrom = true,
  toLabel = "To",
  includeAdjustment,
  children,
}: {
  entities: EntityView[];
  entity: string | null;
  from: string;
  to: string;
  showFrom?: boolean;
  toLabel?: string;
  includeAdjustment?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <form className="flex flex-wrap items-end gap-2 print:hidden" method="get">
      {entities.length > 1 && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Entity</span>
          <select name="entity" defaultValue={entity ?? ""} className={`${selectClass} w-48`}>
            <option value="">All entities</option>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {showFrom ? (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">From</span>
          <Input type="date" name="from" defaultValue={from} className="w-40" />
        </label>
      ) : (
        <input type="hidden" name="from" value={from} />
      )}
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{toLabel}</span>
        <Input type="date" name="to" defaultValue={to} className="w-40" />
      </label>
      {includeAdjustment !== undefined && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Adjustment period</span>
          <select
            name="adj"
            defaultValue={includeAdjustment ? "" : "0"}
            className={`${selectClass} w-36`}
          >
            <option value="">Included</option>
            <option value="0">Left out</option>
          </select>
        </label>
      )}
      {children}
      <Button type="submit" variant="secondary">
        Show
      </Button>
    </form>
  );
}

export function ProblemNote({ problem }: { problem: string | null }) {
  if (!problem) return null;
  return (
    <Alert>
      <AlertDescription>{problem} Showing the fiscal year to date instead.</AlertDescription>
    </Alert>
  );
}
