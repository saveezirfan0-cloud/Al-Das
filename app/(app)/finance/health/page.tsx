import { SetupChecklist } from "@/components/finance/setup-checklist";
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
import { loadFreshness } from "@/lib/finance/freshness";
import { getFinanceHealth } from "@/lib/finance/health";
import { isReady, readinessSteps } from "@/lib/finance/readiness";
import { createClient } from "@/lib/supabase/server";
import {
  CaptureToggle,
  CredentialsForm,
  DigestToggle,
  MaintenanceButtons,
  SettingsForm,
} from "./controls";
import { evaluateAlerts } from "@/lib/finance/alerts";
import { loadAlertSnapshot } from "@/lib/finance/alerts-db";
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
  const admin = createAdminClient();
  const health = await getFinanceHealth(admin, member.orgId);
  const alerts = evaluateAlerts(await loadAlertSnapshot(admin, member.orgId));
  const freshness = await loadFreshness(await createClient());
  const steps = freshness ? readinessSteps(freshness) : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Data health"
        description="Unite capture, the Diligence import and reference-data gaps."
      />

      {steps && !isReady(steps) && (
        <SetupChecklist
          steps={steps}
          allowed={["finance.capture.manage", "finance.reference.manage", "finance.claims.import"]}
        />
      )}

      {alerts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Active alerts</CardTitle>
            <CardDescription>
              The same checks run every hour and notify everyone with Data health access, once per
              problem.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {alerts.map((a) => (
              <Alert key={a.key} variant={a.severity === "critical" ? "destructive" : "default"}>
                <AlertTitle>
                  {a.title}{" "}
                  <Badge
                    variant={
                      a.severity === "critical"
                        ? "destructive"
                        : a.severity === "warning"
                          ? "warning"
                          : "secondary"
                    }
                  >
                    {a.severity}
                  </Badge>
                </AlertTitle>
                <AlertDescription>{a.body}</AlertDescription>
              </Alert>
            ))}
          </CardContent>
        </Card>
      )}

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

      {health.balanceStalled && (
        <Alert variant="destructive">
          <AlertTitle>Remaining balance is not dropping</AlertTitle>
          <AlertDescription>
            The last batches returned records but the remaining balance at Unite did not go down.
            Check the batch log before the next run.
          </AlertDescription>
        </Alert>
      )}
      {(!health.lastImport ||
        Date.now() - new Date(health.lastImport.uploadedAt).getTime() > 8 * 86_400_000) && (
        <Alert>
          <AlertTitle>No Diligence upload in the last 8 days</AlertTitle>
          <AlertDescription>
            Sharaf uploads the unfiltered claims report weekly and at month end (Finance → Insurance
            upload). Claim statuses and ageing are only as fresh as the last upload.
          </AlertDescription>
        </Alert>
      )}
      {health.openCaptureExceptions > 0 && (
        <Alert variant="destructive">
          <AlertTitle>{health.openCaptureExceptions} open capture exception(s)</AlertTitle>
          <AlertDescription>
            A batch failed, a response could not be stored, or the count did not match. Fix the
            cause, then reprocess unprocessed batches. If Unite records were lost, ask Unite to
            re-queue them.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Stat
          label="Last successful capture"
          value={health.lastSuccessfulCaptureAt ? fmt(health.lastSuccessfulCaptureAt) : "Never"}
          hint={
            health.integration.configured
              ? `credentials ${health.integration.status}${health.integration.lastError ? `, last error: ${health.integration.lastError}` : ""}`
              : "no Unite credentials saved"
          }
        />
        <Stat
          label="AppointmentId resolves"
          value={
            health.appointmentResolution.withId === 0
              ? "—"
              : `${Math.round((health.appointmentResolution.resolved / health.appointmentResolution.withId) * 100)}%`
          }
          hint={`${health.appointmentResolution.resolved} of ${health.appointmentResolution.withId} invoices, last 60 days (target above 95%)`}
          bad={
            health.appointmentResolution.withId > 0 &&
            health.appointmentResolution.resolved / health.appointmentResolution.withId < 0.95
          }
        />
        <Stat
          label="Open exceptions"
          value={Object.values(health.openByRule).reduce((n, v) => n + v, 0)}
          hint={
            Object.entries(health.openByRule)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => `${k}: ${v}`)
              .join(", ") || "none"
          }
        />
        <Stat
          label="Invoice number gaps"
          value={health.gaps.reduce((n, g) => n + g.missingCount, 0)}
          hint={`${health.gaps.length} range(s) missing since ${health.windowFrom}`}
          bad={health.gaps.length > 0}
        />
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

      {health.gaps.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Invoice number gaps</CardTitle>
            <CardDescription>
              Numbers missing inside each series. They usually mean records Unite has not delivered
              yet.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Series</TableHead>
                  <TableHead className="text-right">From</TableHead>
                  <TableHead className="text-right">To</TableHead>
                  <TableHead className="text-right">Missing</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {health.gaps.map((g) => (
                  <TableRow key={`${g.series}-${g.missingFrom}`}>
                    <TableCell className="font-mono text-xs">{g.series}</TableCell>
                    <TableCell className="text-right tabular-nums">{g.missingFrom}</TableCell>
                    <TableCell className="text-right tabular-nums">{g.missingTo}</TableCell>
                    <TableCell className="text-right tabular-nums">{g.missingCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Capture controls</CardTitle>
          <CardDescription>
            The Unite Finance API delivers each record once. Turning capture on starts consuming
            records, so do it only after the token check with Make and the Unite re-queue are done.
            Keep &quot;batches per run&quot; at 1 for the first watched run.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <CaptureToggle enabled={health.captureEnabled} />
          <SettingsForm
            batchSize={health.batchSize}
            maxBatches={health.maxBatchesPerRun}
            windowFrom={health.windowFrom}
          />
          <MaintenanceButtons />
          <DigestToggle enabled={health.digestEnabled} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Unite credentials</CardTitle>
          <CardDescription>
            {health.integration.configured
              ? "Saved. Leave a field blank to keep its stored value."
              : "Not configured yet."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CredentialsForm configured={health.integration.configured} />
        </CardContent>
      </Card>
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
