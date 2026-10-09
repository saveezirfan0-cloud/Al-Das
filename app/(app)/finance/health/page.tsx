import { PageHeader } from "@/components/shell/page-header";
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
import { requirePerm } from "@/lib/auth/session";
import { getFinanceHealth } from "@/lib/finance/health";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Finance data health" };
export const dynamic = "force-dynamic";

const STATUS_VARIANT = {
  received: "warning",
  processed: "success",
  failed: "destructive",
} as const;

function fmt(iso: string | null | undefined) {
  return iso ? new Date(iso).toLocaleString() : "—";
}

export default async function FinanceHealthPage() {
  const member = await requirePerm("finance.capture.manage");
  const health = await getFinanceHealth(createAdminClient(), member.orgId);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Data health"
        description="Unite capture, the Diligence import and reference-data gaps."
      />

      {!health.captureEnabled && (
        <Alert>
          <AlertTitle>Unite capture is switched off</AlertTitle>
          <AlertDescription>
            Nothing calls the Unite Finance API. The API delivers each record once, so capture is
            enabled only after the token check with Make and the Unite re-queue are done.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Capture" value={health.captureEnabled ? "On" : "Off"} />
        <Stat
          label="Remaining at Unite"
          value={health.remainingBalance ?? "—"}
          hint={`window from ${health.windowFrom}`}
        />
        <Stat
          label="Unprocessed batches"
          value={health.pendingBatches}
          hint="received or failed"
          bad={health.pendingBatches > 0}
        />
        <Stat
          label="Unknown clinics"
          value={health.unknownClinicInvoices}
          hint="invoices without a branch"
          bad={health.unknownClinicInvoices > 0}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Stat
          label="Unmapped services"
          value={health.unmappedServices}
          hint="need a service category"
          bad={health.unmappedServices > 0}
        />
        <Stat
          label="Last Diligence import"
          value={health.lastImport ? fmt(health.lastImport.uploadedAt) : "None yet"}
          hint={
            health.lastImport
              ? `${health.lastImport.status}, ${health.lastImport.rowCount ?? "?"} rows`
              : "no file uploaded"
          }
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Batch log</CardTitle>
          <CardDescription>
            Latest 25 captures. Payloads contain patient data and are never shown here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {health.batches.length === 0 ? (
            <p className="text-muted-foreground text-sm">No batches captured yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Requested</TableHead>
                  <TableHead>Range</TableHead>
                  <TableHead>Unite status</TableHead>
                  <TableHead className="text-right">Records</TableHead>
                  <TableHead className="text-right">Remaining</TableHead>
                  <TableHead>Processing</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {health.batches.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell className="text-xs">{fmt(b.requestedAt)}</TableCell>
                    <TableCell className="text-xs">
                      {b.fromDate} → {b.toDate}
                    </TableCell>
                    <TableCell className="text-xs">
                      {b.httpStatus ?? "—"} {b.messageStatus ?? ""}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {b.recordCount ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {b.balanceInRange ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[b.processStatus]}>{b.processStatus}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground max-w-64 truncate text-xs">
                      {b.error ?? ""}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <p className="text-muted-foreground text-xs">
        Invoice-number gap report and the stalled-balance alert arrive with capture (phase F2).
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  bad,
}: {
  label: string;
  value: string | number;
  hint?: string;
  bad?: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className={bad ? "text-destructive text-2xl" : "text-2xl"}>{value}</CardTitle>
      </CardHeader>
      {hint && <CardContent className="text-muted-foreground text-xs">{hint}</CardContent>}
    </Card>
  );
}
