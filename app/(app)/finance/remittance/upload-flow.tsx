"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Loader2, Upload } from "lucide-react";
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
import { createClient } from "@/lib/supabase/client";

import {
  commitRemittanceFile,
  createRemittanceUpload,
  discardRemittanceFile,
  processRemittanceUpload,
  type RemitOutcome,
} from "./actions";

const FLAG_LABEL: Record<string, string> = {
  short_paid: "Short paid",
  overpaid: "Overpaid",
  denied: "Denied",
  unmatched: "No claim found",
  ambiguous: "Several claims fit",
  payer_mismatch: "Payer differs",
  invoice_mismatch: "Invoice differs",
  billed_below_contract: "Billed below contract",
  billed_above_contract: "Billed above contract",
  duplicate_in_file: "Repeated line",
  taken_back: "Taken back",
};

export function RemittanceUpload() {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<null | "uploading" | "processing">(null);
  const [outcome, setOutcome] = useState<RemitOutcome | null>(null);
  const [pending, start] = useTransition();
  const [done, setDone] = useState<{
    batchId: string;
    lines: number;
    duplicatesSkipped: number;
    short: number;
    unmatched: number;
  } | null>(null);

  async function onFile(file: File) {
    setOutcome(null);
    setDone(null);
    try {
      setBusy("uploading");
      const prep = await createRemittanceUpload({ filename: file.name, size: file.size });
      if (!prep.ok || !prep.data) throw new Error(prep.ok ? "Upload failed" : prep.error);
      const { error } = await createClient()
        .storage.from("finance-files")
        .uploadToSignedUrl(prep.data.path, prep.data.token, file, {
          contentType: /\.csv$/i.test(file.name)
            ? "text/csv"
            : /\.xml$/i.test(file.name)
              ? "text/xml"
              : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
      if (error) throw new Error(error.message);
      setBusy("processing");
      const res = await processRemittanceUpload({ path: prep.data.path, filename: file.name });
      if (!res.ok || !res.data) throw new Error(res.ok ? "Could not process the file" : res.error);
      setOutcome(res.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(null);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Upload a payment advice</CardTitle>
          <CardDescription>
            The payer&apos;s remittance as .xlsx, .csv or the .xml advice downloaded from Diligence.
            It is checked first and nothing is saved until you confirm. The original file is deleted
            right after it is read; patient names and member IDs are never stored.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <input
            ref={input}
            type="file"
            accept=".xlsx,.csv,.xml,text/xml,application/xml,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          />
          <Button disabled={!!busy || pending} onClick={() => input.current?.click()}>
            {busy ? <Loader2 className="animate-spin" /> : <Upload />}
            {busy === "uploading"
              ? "Uploading…"
              : busy === "processing"
                ? "Checking the file…"
                : "Choose a file"}
          </Button>
        </CardContent>
      </Card>

      {done && (
        <Alert>
          <AlertTitle>Reconciled</AlertTitle>
          <AlertDescription>
            {done.lines} line(s) saved
            {done.duplicatesSkipped
              ? `, ${done.duplicatesSkipped} already held and skipped`
              : ""}. {done.short} short payment(s), {done.unmatched} line(s) without a single
            matching claim.{" "}
            <Link className="underline" href={`/finance/remittance/${done.batchId}`}>
              Review the lines
            </Link>
          </AlertDescription>
        </Alert>
      )}

      {outcome?.kind === "duplicate" && (
        <Alert>
          <AlertTitle>Already reconciled</AlertTitle>
          <AlertDescription>
            This exact file was committed before
            {outcome.committedAt
              ? ` (${new Date(outcome.committedAt).toLocaleString("en-GB")})`
              : ""}
            . Nothing was changed.
          </AlertDescription>
        </Alert>
      )}

      {outcome?.kind === "rejected" && (
        <Alert variant="destructive">
          <AlertTitle>
            The file was not accepted ({outcome.totalErrors} problem
            {outcome.totalErrors === 1 ? "" : "s"})
          </AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            {outcome.header.missingRequired.length > 0 && (
              <p>Missing columns: {outcome.header.missingRequired.join(", ")}.</p>
            )}
            {outcome.header.unrecognised.length > 0 && (
              <p>
                Columns not recognised (ignored):{" "}
                {outcome.header.unrecognised.slice(0, 12).join(", ")}.
              </p>
            )}
            <ul className="list-disc pl-5 text-xs">
              {outcome.errors.slice(0, 15).map((e, i) => (
                <li key={i}>
                  {e.row ? `Row ${e.row}: ` : ""}
                  {e.code.replaceAll("_", " ")}
                  {e.field ? ` (${e.field.replaceAll("_", " ")})` : ""}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {outcome?.kind === "staged" && (
        <Card>
          <CardHeader>
            <CardTitle>Preview</CardTitle>
            <CardDescription>
              {outcome.preview.stats.rows} line(s), {outcome.preview.stats.refs} advice
              reference(s), {money(outcome.preview.stats.sumPaid)} paid
              {outcome.preview.stats.minPaidOn
                ? `, dated ${outcome.preview.stats.minPaidOn} to ${outcome.preview.stats.maxPaidOn}`
                : ""}
              . Expected from the price list on {outcome.preview.pricedLines} line(s); the
              claim&apos;s net on the rest.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge variant="success">{outcome.preview.summary.matched} matched</Badge>
              {outcome.preview.summary.unmatched > 0 && (
                <Badge variant="destructive">
                  {outcome.preview.summary.unmatched} without a claim
                </Badge>
              )}
              {outcome.preview.summary.ambiguous > 0 && (
                <Badge variant="warning">{outcome.preview.summary.ambiguous} ambiguous</Badge>
              )}
              <Badge variant={outcome.preview.summary.short > 0 ? "warning" : "secondary"}>
                {outcome.preview.summary.short} short ({money(outcome.preview.summary.sumShort)})
              </Badge>
              {outcome.preview.summary.overpaid > 0 && (
                <Badge variant="secondary">{outcome.preview.summary.overpaid} overpaid</Badge>
              )}
            </div>
            {outcome.preview.header.droppedSensitive.length > 0 && (
              <p className="text-muted-foreground text-xs">
                Ignored {outcome.preview.header.droppedSensitive.length} personal column(s): they
                are never stored.
              </p>
            )}
            {outcome.preview.attention.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Row</TableHead>
                    <TableHead>Claim / invoice</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                    <TableHead className="text-right">Expected</TableHead>
                    <TableHead className="text-right">Short</TableHead>
                    <TableHead>Flags</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {outcome.preview.attention.slice(0, 25).map((r) => (
                    <TableRow key={r.row_no}>
                      <TableCell className="text-xs">{r.row_no}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {r.claim_activity_number ?? `${r.invoice_no ?? ""} ${r.cpt_code ?? ""}`}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {money(r.paid_amount)}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {r.expected_amount === null ? "—" : money(r.expected_amount)}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {r.short_amount ? money(r.short_amount) : "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.flags.map((f) => FLAG_LABEL[f] ?? f).join(", ")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <div className="flex gap-2">
              <Button
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const res = await commitRemittanceFile(outcome.fileId);
                    if (res.ok && res.data) {
                      toast.success(res.message);
                      setDone(res.data);
                      setOutcome(null);
                    } else if (!res.ok) toast.error(res.error);
                  })
                }
              >
                {pending && <Loader2 className="animate-spin" />} Save the reconciliation
              </Button>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const res = await discardRemittanceFile(outcome.fileId);
                    if (res.ok) {
                      toast.success(res.message);
                      setOutcome(null);
                    } else toast.error(res.error);
                  })
                }
              >
                Discard
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
