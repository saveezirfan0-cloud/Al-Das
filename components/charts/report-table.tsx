import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatValue } from "@/lib/reports/format";
import type { ReportResult } from "@/lib/reports/types";

/** The table view: every chart's numbers are also here, so nothing depends on color or hover. */
export function ReportTable({ table }: { table: ReportResult["table"] }) {
  if (table.rows.length === 0) return <p className="text-muted-foreground text-sm">No rows for this period.</p>;
  return (
    <div className="max-h-[28rem] overflow-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            {table.columns.map((c) => (
              <TableHead key={c.key} className={c.format && c.format !== "text" ? "text-right" : undefined}>
                {c.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {table.rows.map((row, i) => (
            <TableRow key={i}>
              {table.columns.map((c) => (
                <TableCell key={c.key} className={c.format && c.format !== "text" ? "text-right tabular-nums" : undefined}>
                  {formatValue(row[c.key], c.format ?? "text")}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
