"use client";

import { useRef, useState, useTransition } from "react";
import { Check, Loader2, Upload, X } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { money } from "@/lib/finance/format";
import { RECONCILED_TOTAL_KEYS, RECONCILED_TOTALS } from "@/lib/finance/unite-report-mapping";
import type { CommitResult, UploadSummary } from "@/lib/finance/unite-report-service";
import { createClient } from "@/lib/supabase/client";

import {
  commitUniteReportUpload,
  createUniteReportUpload,
  discardUniteReportUpload,
  getUniteReportUpload,
  processUniteReportUpload,
} from "./unite-report-actions";

export type RecentReportUpload = {
  id: string;
  fromDate: string;
  toDate: string;
  status: string;
  rowCount: number;
  reconciled: boolean;
  createdBy: string;
  createdAt: string;
  committedBy: string;
  committedAt: string | null;
};

const STATUS_VARIANT = { committed: "success", staged: "warning" } as const;

export function UniteReportFlow({ recent }: { recent: RecentReportUpload[] }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<null | "uploading" | "processing">(null);
  const [summary, setSummary] = useState<UploadSummary | null>(null);
  const [done, setDone] = useState<CommitResult | null>(null);
  const [pending, startTransition] = useTransition();

  async function onFile(file: File) {
    setSummary(null);
    setDone(null);
    try {
      setBusy("uploading");
      const prep = await createUniteReportUpload({ filename: file.name, size: file.size });
      if (!prep.ok) throw new Error(prep.error);
      const { error } = await createClient()
        .storage.from("finance-files")
        .uploadToSignedUrl(prep.data.path, prep.data.token, file, {
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
      if (error) throw new Error("The upload did not finish. Try again.");
      setBusy("processing");
      const res = await processUniteReportUpload({ path: prep.data.path });
      if (!res.ok) throw new Error(res.error);
      setSummary(res.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(null);
      if (input.current) input.current.value = "";
    }
  }

  function review(id: string) {
    setDone(null);
    startTransition(async () => {
      const res = await getUniteReportUpload(id);
      if (res.ok) setSummary(res.data);
      else toast.error(res.error);
    });
  }

  function commit(id: string) {
    startTransition(async () => {
      const res = await commitUniteReportUpload(id);
      if (res.ok) {
        toast.success(res.message);
        setDone(res.data);
        setSummary(null);
      } else toast.error(res.error);
    });
  }

  function discard(id: string) {
    startTransition(async () => {
      const res = await discardUniteReportUpload(id);
      if (res.ok) {
        toast.success(res.message);
        setSummary(null);
      } else toast.error(res.error);
    });
  }

  const staged = summary?.status === "staged";

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Unite collection report</CardTitle>
          <CardDescription>
            The Daily Collection Multi-Clinic Report exported from Unite (.xlsx), one month at a
            time. The file is checked against its own Invoice Total row and nothing changes until
            you commit. The original file is deleted right after it is read; patient names,
            insurance card numbers, remarks and staff names are never stored.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <input
            ref={input}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            aria-label="Unite collection report file"
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          />
          <Button disabled={!!busy || pending} onClick={() => input.current?.click()}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Upload aria-hidden />}
            {busy === "uploading"
              ? "Uploading…"
              : busy === "processing"
                ? "Checking the report…"
                : "Choose .xlsx file"}
          </Button>
        </CardContent>
      </Card>

      {done && (
        <Alert>
          <AlertTitle>Report committed</AlertTitle>
          <AlertDescription>
            {done.rows} row(s) are now current
            {done.superseded ? `, replacing ${done.superseded} row(s) from earlier uploads` : ""}.
            {done.unknownBranchRows > 0 &&
              ` ${done.unknownBranchRows} row(s) have a clinic name that is not mapped to a branch (Finance, Reference data, branches).`}
          </AlertDescription>
        </Alert>
      )}

      {summary && (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              {summary.fromDate} to {summary.toDate}
              <Badge variant={summary.reconciled ? "success" : "destructive"}>
                {summary.reconciled ? "Reconciled" : "Does not reconcile"}
              </Badge>
              <Badge
                variant={
                  STATUS_VARIANT[summary.status as keyof typeof STATUS_VARIANT] ?? "secondary"
                }
              >
                {summary.status}
              </Badge>
            </CardTitle>
            {summary.existing && (
              <CardDescription>
                This exact file was uploaded before; this is the earlier upload, unchanged.
              </CardDescription>
            )}
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-5">
              <Figure label="Rows" value={summary.rowCount} />
              <Figure label="Doctors" value={summary.doctors} />
              <Figure label="Clinics" value={summary.clinics} />
              <Figure label="Cancelled rows" value={summary.cancelledRows} />
              <Figure
                label="Rows with no branch"
                value={summary.unknownBranchRows}
                bad={summary.unknownBranchRows > 0}
              />
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Column</TableHead>
                  <TableHead className="text-right">Report total</TableHead>
                  <TableHead className="text-right">Sum of rows</TableHead>
                  <TableHead className="w-16 text-center">Match</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {RECONCILED_TOTAL_KEYS.map((k) => {
                  const match =
                    Math.round(summary.reportTotals[k] * 100) ===
                    Math.round(summary.rowTotals[k] * 100);
                  return (
                    <TableRow key={k}>
                      <TableCell>{RECONCILED_TOTALS[k]}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {money(summary.reportTotals[k])}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {money(summary.rowTotals[k])}
                      </TableCell>
                      <TableCell className="text-center">
                        {match ? (
                          <Check
                            className="mx-auto size-4 text-emerald-700 dark:text-emerald-300"
                            aria-label="Matches"
                          />
                        ) : (
                          <X className="text-destructive mx-auto size-4" aria-label="Differs" />
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {summary.problems.length > 0 && (
              <ul className="text-muted-foreground list-disc pl-5 text-sm">
                {summary.problems.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            )}
            {staged && (
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={pending || !summary.reconciled}
                  onClick={() => commit(summary.uploadId)}
                >
                  {pending && <Loader2 className="animate-spin" aria-hidden />} Commit
                </Button>
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => discard(summary.uploadId)}
                >
                  Discard
                </Button>
                {!summary.reconciled && (
                  <p className="text-muted-foreground self-center text-sm">
                    A report that does not reconcile cannot be committed. Export it again from
                    Unite.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent collection report uploads</CardTitle>
          <CardDescription>Latest 20.</CardDescription>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing uploaded yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Dates</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                  <TableHead>Uploaded</TableHead>
                  <TableHead>Committed</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="text-xs whitespace-nowrap">
                      {u.fromDate} to {u.toDate}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          STATUS_VARIANT[u.status as keyof typeof STATUS_VARIANT] ?? "secondary"
                        }
                      >
                        {u.status === "staged" ? "awaiting review" : u.status}
                      </Badge>
                      {!u.reconciled && (
                        <span className="text-destructive ml-2 text-xs">not reconciled</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{u.rowCount}</TableCell>
                    <TableCell className="text-xs">
                      {u.createdBy}, {new Date(u.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-xs">
                      {u.committedAt
                        ? `${u.committedBy}, ${new Date(u.committedAt).toLocaleString()}`
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {u.status === "staged" && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending || !!busy}
                          onClick={() => review(u.id)}
                        >
                          Review
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Figure({ label, value, bad }: { label: string; value: number; bad?: boolean }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className={bad ? "text-destructive text-2xl font-semibold" : "text-2xl font-semibold"}>
        {value}
      </div>
    </div>
  );
}
