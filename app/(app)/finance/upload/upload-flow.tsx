"use client";

import { useRef, useState, useTransition } from "react";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";

import {
  commitDiligenceImport,
  createDiligenceUpload,
  discardDiligenceImport,
  processDiligenceUpload,
  type ProcessOutcome,
} from "./actions";

const money = (n: number) =>
  n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function UploadFlow() {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<null | "uploading" | "processing">(null);
  const [outcome, setOutcome] = useState<ProcessOutcome | null>(null);
  const [raiseMissing, setRaiseMissing] = useState(true);
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState<Record<string, number> | null>(null);

  async function onFile(file: File) {
    setOutcome(null);
    setDone(null);
    try {
      setBusy("uploading");
      const prep = await createDiligenceUpload({ filename: file.name, size: file.size });
      if (!prep.ok) throw new Error(prep.error);
      const { error } = await createClient()
        .storage.from("finance-files")
        .uploadToSignedUrl(prep.data.path, prep.data.token, file, {
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
      if (error) throw new Error(error.message);
      setBusy("processing");
      const res = await processDiligenceUpload({ path: prep.data.path, filename: file.name });
      if (!res.ok) throw new Error(res.error);
      setOutcome(res.data);
      if (res.data.kind === "staged") setRaiseMissing(!res.data.preview.looksFiltered);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(null);
      if (input.current) input.current.value = "";
    }
  }

  function commit(fileId: string) {
    startTransition(async () => {
      const res = await commitDiligenceImport({ fileId, raiseMissing });
      if (res.ok) {
        toast.success(res.message);
        setDone(res.data);
        setOutcome(null);
      } else toast.error(res.error);
    });
  }

  function discard(fileId: string) {
    startTransition(async () => {
      const res = await discardDiligenceImport(fileId);
      if (res.ok) {
        toast.success(res.message);
        setOutcome(null);
      } else toast.error(res.error);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Upload the Diligence claims report</CardTitle>
          <CardDescription>
            The unfiltered export: all claims, all statuses, from 01-01-2026. The file is checked
            first and nothing is saved until you confirm. The original file is deleted right after
            it is read; names, Emirates IDs and member IDs are never stored.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <input
            ref={input}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          />
          <Button disabled={!!busy || pending} onClick={() => input.current?.click()}>
            {busy ? <Loader2 className="animate-spin" /> : <Upload />}
            {busy === "uploading"
              ? "Uploading…"
              : busy === "processing"
                ? "Checking the file…"
                : "Choose .xlsx file"}
          </Button>
        </CardContent>
      </Card>

      {done && (
        <Alert>
          <AlertTitle>Import committed</AlertTitle>
          <AlertDescription>
            {done.upserted} claim row(s) saved, {done.events} change event(s) recorded,{" "}
            {done.matched_changed} claim(s) newly matched to invoices
            {done.missing_raised ? `, ${done.missing_raised} missing claim(s) flagged (E06)` : ""}.
          </AlertDescription>
        </Alert>
      )}

      {outcome?.kind === "duplicate" && (
        <Alert>
          <AlertTitle>This exact file was already imported</AlertTitle>
          <AlertDescription>
            Imported on {new Date(outcome.committedAt).toLocaleString()}. Nothing was changed.
          </AlertDescription>
        </Alert>
      )}

      {outcome?.kind === "rejected" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">The file was rejected</CardTitle>
            <CardDescription>
              {outcome.totalErrors} problem(s). Nothing was saved. Fix the export and upload it
              again; an exception (E10) was opened for follow-up.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            {outcome.header.missingRequired.length > 0 && (
              <p>
                <strong>Required columns not found:</strong>{" "}
                {outcome.header.missingRequired.join(", ")}
              </p>
            )}
            {outcome.header.unrecognised.length > 0 && (
              <p>
                <strong>Columns in your file that were not recognised:</strong>{" "}
                {outcome.header.unrecognised.join(", ")}
              </p>
            )}
            {outcome.header.duplicateHeaders.length > 0 && (
              <p>
                <strong>Duplicate columns:</strong> {outcome.header.duplicateHeaders.join(", ")}
              </p>
            )}
            <ul className="text-muted-foreground list-disc pl-5">
              {outcome.errors.slice(0, 25).map((e, i) => (
                <li key={i}>
                  {e.row ? `Row ${e.row}: ` : ""}
                  {e.code.replaceAll("_", " ")}
                  {e.field ? ` (${e.field})` : ""}
                </li>
              ))}
              {outcome.totalErrors > 25 && <li>… and {outcome.totalErrors - 25} more</li>}
            </ul>
          </CardContent>
        </Card>
      )}

      {outcome?.kind === "staged" && (
        <Card>
          <CardHeader>
            <CardTitle>Check before importing</CardTitle>
            <CardDescription>{outcome.preview.fileName}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-4">
              <Figure label="New" value={outcome.preview.counts.new} />
              <Figure label="Changed" value={outcome.preview.counts.changed} />
              <Figure label="Unchanged" value={outcome.preview.counts.unchanged} />
              <Figure
                label="Missing since last file"
                value={outcome.preview.counts.missing}
                bad={outcome.preview.counts.missing > 0}
              />
            </div>
            <p className="text-muted-foreground text-sm">
              {outcome.preview.stats.rows} rows, transaction dates{" "}
              {outcome.preview.stats.minTransactionDate ?? "?"} to{" "}
              {outcome.preview.stats.maxTransactionDate ?? "?"}. Net{" "}
              {money(outcome.preview.stats.sumNet)}, remitted{" "}
              {money(outcome.preview.stats.sumRemitted)}, rejected{" "}
              {money(outcome.preview.stats.sumRejected)}.
            </p>
            {Object.keys(outcome.preview.changedFieldCounts).length > 0 && (
              <div className="flex flex-wrap gap-2">
                {Object.entries(outcome.preview.changedFieldCounts).map(([f, n]) => (
                  <Badge key={f} variant="secondary">
                    {f.replaceAll("_", " ")}: {n}
                  </Badge>
                ))}
              </div>
            )}
            {outcome.preview.header.droppedSensitive.length > 0 && (
              <p className="text-muted-foreground text-xs">
                Not imported (sensitive): {outcome.preview.header.droppedSensitive.join(", ")}.
              </p>
            )}
            {outcome.preview.header.unrecognised.length > 0 && (
              <p className="text-muted-foreground text-xs">
                Ignored (not recognised): {outcome.preview.header.unrecognised.join(", ")}.
              </p>
            )}
            {outcome.preview.looksFiltered && (
              <Alert variant="destructive">
                <AlertTitle>This looks like a filtered export</AlertTitle>
                <AlertDescription>
                  Many claims from the previous file are missing. Production uploads must be
                  unfiltered. Flagging them as missing is switched off; tick the box only if they
                  really disappeared.
                </AlertDescription>
              </Alert>
            )}
            {outcome.preview.counts.missing > 0 && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="raise"
                  checked={raiseMissing}
                  onCheckedChange={(v) => setRaiseMissing(v === true)}
                />
                <Label htmlFor="raise">
                  Open an exception (E06) for the {outcome.preview.counts.missing} missing claim(s)
                </Label>
              </div>
            )}
            <div className="flex gap-2">
              <Button disabled={pending} onClick={() => commit(outcome.fileId)}>
                {pending && <Loader2 className="animate-spin" />} Confirm import
              </Button>
              <Button variant="outline" disabled={pending} onClick={() => discard(outcome.fileId)}>
                Discard
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
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
