import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { VOUCHER_TYPE_LABELS } from "@/lib/accounting/journal";
import { REFUSAL_LABELS, type TallyPlanReport } from "@/lib/accounting/tally/plan";
import { money } from "@/lib/finance/format";

/** The dry run of a Tally import, as stored on the import (no hooks: shown by the server page and the upload flow). */

const label = (code: string) => REFUSAL_LABELS[code as keyof typeof REFUSAL_LABELS] ?? code;

function Stat({ name, value }: { name: string; value: number | string }) {
  return (
    <div className="flex flex-col">
      <span className="text-muted-foreground text-xs">{name}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
    </div>
  );
}

export function DryRunReport({ report }: { report: TallyPlanReport }) {
  const c = report.counts;
  return (
    <div className="flex flex-col gap-4">
      {report.blocking.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>The import cannot be committed</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {report.blocking.map((b) => (
                <li key={b}>{label(b)}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>What the files hold{report.company ? `: ${report.company}` : ""}</CardTitle>
          <CardDescription>
            Nothing has been created yet. Cancelled and optional vouchers are skipped; post-dated
            vouchers are imported on their date.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat name="Groups" value={c.groups} />
          <Stat name="Ledgers" value={c.ledgers} />
          <Stat name="Cost centres" value={c.costCentres} />
          <Stat name="Vouchers" value={c.vouchers} />
          <Stat name="To post" value={c.toPost} />
          <Stat name="Already posted, unchanged" value={c.unchanged} />
          <Stat name="Altered in Tally (re-posted)" value={c.altered} />
          <Stat name="Refused" value={c.refused} />
          <Stat name="Cancelled (skipped)" value={c.cancelled} />
          <Stat name="Optional (skipped)" value={c.optional} />
          <Stat name="Post-dated" value={c.postDated} />
          <Stat name="Older than posted (skipped)" value={c.older} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Groups and ledgers</CardTitle>
          <CardDescription>
            {report.groups.predefined} of Tally&apos;s predefined groups map onto the same groups in
            Pulse. {report.groups.create.length} new group(s) and {report.ledgers.create} new
            ledger(s) will be created; {report.ledgers.linkedByGuid} ledger(s) are already linked by
            Tally&apos;s GUID.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 overflow-x-auto">
          {report.groups.create.length > 0 && (
            <div>
              <h3 className="mb-1 text-sm font-medium">New groups</h3>
              <p className="text-muted-foreground text-sm">
                {report.groups.create
                  .map((g) => `${g.name} (under ${g.parent ?? "the top level"})`)
                  .join("; ")}
              </p>
            </div>
          )}
          {report.groups.linked.length + report.ledgers.linkByName.length > 0 && (
            <div>
              <h3 className="mb-1 text-sm font-medium">Linked to an account with the same name</h3>
              <p className="text-muted-foreground text-sm">
                {[...report.groups.linked, ...report.ledgers.linkByName]
                  .map((l) => `${l.name} → ${l.code}`)
                  .join("; ")}
              </p>
            </div>
          )}
          {report.groups.refused.length + report.ledgers.refused.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Refused group or ledger</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...report.groups.refused, ...report.ledgers.refused].map((r) => (
                  <TableRow key={r.name}>
                    <TableCell>{r.name}</TableCell>
                    <TableCell>{label(r.code)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {report.costCentres.create.length > 0 && (
            <p className="text-muted-foreground text-sm">
              New cost centres: {report.costCentres.create.join(", ")}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Opening trial balance
            {report.opening.lines > 0 && (
              <Badge variant={report.opening.balanced ? "success" : "destructive"}>
                {report.opening.balanced
                  ? "Nets to zero"
                  : `Difference ${money(report.opening.difference)}`}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            {report.opening.lines > 0
              ? `${report.opening.lines} ledger(s) with an opening balance, posted as one opening journal dated ${report.opening.date ?? "(choose a date)"}.`
              : "No opening balances in the files."}
          </CardDescription>
        </CardHeader>
        {report.opening.lines > 0 && (
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tally group</TableHead>
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.opening.byGroup.map((g) => (
                  <TableRow key={g.group}>
                    <TableCell>{g.group}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {g.debit ? money(g.debit) : ""}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {g.credit ? money(g.credit) : ""}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="font-medium">
                  <TableCell>Total</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(report.opening.debit)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(report.opening.credit)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        )}
      </Card>

      {report.months.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Vouchers to post, per month and type</CardTitle>
            <CardDescription>
              {report.firstDate} to {report.lastDate}. Each voucher balances (debits equal credits).
              Custom voucher types:{" "}
              {report.voucherTypes.mapped
                .map((t) => `${t.name} → ${VOUCHER_TYPE_LABELS[t.base]}`)
                .join("; ") || "none"}
              .
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Vouchers</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.months.map((m) => (
                  <TableRow key={`${m.month}-${m.type}`}>
                    <TableCell>{m.month}</TableCell>
                    <TableCell>{VOUCHER_TYPE_LABELS[m.type]}</TableCell>
                    <TableCell className="text-right tabular-nums">{m.count}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(m.amount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {(report.refusedTotal > 0 || report.voucherTypes.refused.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle>Refused vouchers ({report.refusedTotal})</CardTitle>
            <CardDescription>
              They are not imported. Fix them in Tally and import again; the rest is not posted
              twice.
              {report.voucherTypes.refused.length > 0 &&
                ` Voucher types that are not accounting vouchers: ${report.voucherTypes.refused.map((t) => `${t.name} (${t.count})`).join(", ")}.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Number</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.refusals.map((r, i) => (
                  <TableRow key={`${r.guid ?? "x"}-${i}`}>
                    <TableCell>{r.date ?? ""}</TableCell>
                    <TableCell>{r.type ?? ""}</TableCell>
                    <TableCell>{r.number ?? ""}</TableCell>
                    <TableCell>{label(r.code)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {(report.warnings.costCentresDropped > 0 || report.warnings.openingBills > 0) && (
        <Alert>
          <AlertTitle>Worth knowing</AlertTitle>
          <AlertDescription>
            {report.warnings.costCentresDropped > 0 &&
              `${report.warnings.costCentresDropped} line(s) use cost centres in several categories at once; the amount is imported whole, without the split. `}
            {report.warnings.openingBills > 0 &&
              `${report.warnings.openingBills} opening bill(s) (bill-wise details) are not imported yet; the ledger totals are.`}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
