"use client";

import { useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ExportResult } from "@/lib/finance/unite-export-server";
import { createClient } from "@/lib/supabase/client";

import { createUniteExportUpload, processUniteExportUpload } from "./unite-export-actions";

export function UniteExportFlow() {
  const input = useRef<HTMLInputElement>(null);
  const [pulledOn, setPulledOn] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState<null | "uploading" | "processing">(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const ready = confirm.trim().toUpperCase() === "UPLOAD" && pulledOn !== "";

  async function onFile(file: File) {
    setResult(null);
    try {
      setBusy("uploading");
      const prep = await createUniteExportUpload({ filename: file.name, size: file.size });
      if (!prep.ok) throw new Error(prep.error);
      const { error } = await createClient()
        .storage.from("finance-files")
        .uploadToSignedUrl(prep.data.path, prep.data.token, file, {
          contentType: "application/json",
        });
      if (error) throw new Error("The upload did not finish. Try again.");
      setBusy("processing");
      const res = await processUniteExportUpload({
        path: prep.data.path,
        filename: file.name,
        pulledOn,
        confirm,
      });
      if (!res.ok) throw new Error(res.error);
      setResult(res.data);
      if (!res.data.failed) toast.success("Export stored and processed.");
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
          <CardTitle>Saved Unite export</CardTitle>
          <CardDescription>
            Upload the saved invoice pull from Unite (a .json file) once. Nothing is sent to Unite.
            The records are stored first, then added to the invoices exactly like a normal capture.
            Newer data from Unite always wins over this file, so enter the date the file was pulled.
            The file is not kept after it is read; uploading the same file again changes nothing.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="export-pulled-on">Date this export was pulled from Unite</Label>
              <Input
                id="export-pulled-on"
                type="date"
                value={pulledOn}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setPulledOn(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="export-confirm">Type UPLOAD to confirm</Label>
              <Input
                id="export-confirm"
                value={confirm}
                autoComplete="off"
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
          </div>
          <input
            ref={input}
            type="file"
            accept=".json,application/json"
            className="hidden"
            aria-label="Saved Unite export file"
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          />
          <div>
            <Button disabled={!ready || !!busy} onClick={() => input.current?.click()}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Upload aria-hidden />}
              {busy === "uploading"
                ? "Uploading…"
                : busy === "processing"
                  ? "Storing and processing…"
                  : "Choose .json file"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {result && (
        <Alert variant={result.failed ? "destructive" : "default"}>
          <AlertTitle>
            {result.failed ? "Stored, but processing stopped" : "Export stored and processed"}
          </AlertTitle>
          <AlertDescription>
            {result.records} record(s) in {result.chunks} part(s). {result.storedNow} stored now,{" "}
            {result.alreadyStored} already stored; {result.processedNow} processed now,{" "}
            {result.alreadyProcessed} already processed.
            {result.failed &&
              ` Part ${result.failed.chunk} could not be mapped (${result.failed.error}); ${result.notProcessed} part(s) wait. The stored data is safe and can be replayed once the mapping is fixed.`}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
