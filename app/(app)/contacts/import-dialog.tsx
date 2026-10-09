"use client";

import * as React from "react";
import { FileUp, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { CustomFieldDef } from "@/lib/contacts/custom-values";
import { guessMapping, IMPORTABLE_FIELDS } from "@/lib/contacts/fields";
import { prepareImport, type PreparedRow, type PrepareSummary } from "@/lib/contacts/import";
import { parseCsv, type ParsedCsv } from "@/lib/csv";

import { importContactsChunk, type ImportChunkResult } from "./actions";

const SKIP = "__skip__";
const CHUNK = 250;

export function ImportDialog({
  open,
  onOpenChange,
  customFields,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  customFields: CustomFieldDef[];
  onDone: () => void;
}) {
  const [step, setStep] = React.useState<"upload" | "map" | "review" | "running" | "done">(
    "upload",
  );
  const [csv, setCsv] = React.useState<ParsedCsv | null>(null);
  const [fileName, setFileName] = React.useState("");
  const [mapping, setMapping] = React.useState<Record<string, string | null>>({});
  const [mode, setMode] = React.useState<"skip" | "update">("skip");
  const [prepared, setPrepared] = React.useState<{
    rows: PreparedRow[];
    summary: PrepareSummary;
  } | null>(null);
  const [progress, setProgress] = React.useState(0);
  const [result, setResult] = React.useState<ImportChunkResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setStep("upload");
      setCsv(null);
      setFileName("");
      setMapping({});
      setPrepared(null);
      setProgress(0);
      setResult(null);
      setError(null);
    }
  }, [open]);

  async function onFile(file: File) {
    if (file.size > 20 * 1024 * 1024) {
      setError("Files over 20 MB: split them first.");
      return;
    }
    const text = await file.text();
    const parsed = parseCsv(text);
    if (parsed.headers.length === 0 || parsed.rows.length === 0) {
      setError("The file has no rows.");
      return;
    }
    setError(null);
    setCsv(parsed);
    setFileName(file.name);
    setMapping(guessMapping(parsed.headers, customFields));
    setStep("map");
  }

  function review() {
    if (!csv) return;
    if (!Object.values(mapping).includes("phone")) {
      setError("Map a Phone column: contacts are matched by phone number.");
      return;
    }
    setError(null);
    setPrepared(prepareImport(csv.headers, csv.rows, { mapping, customFields }));
    setStep("review");
  }

  async function run() {
    if (!prepared) return;
    const ok = prepared.rows.filter((r) => r.status === "ok").map((r) => r.contact);
    if (ok.length === 0) {
      setError("No valid rows to import.");
      return;
    }
    setStep("running");
    const batchId = `csv-${Date.now().toString(36)}`;
    const totals: ImportChunkResult = { created: 0, updated: 0, skipped: 0, failed: 0, errors: [] };
    for (let i = 0; i < ok.length; i += CHUNK) {
      const res = await importContactsChunk({ rows: ok.slice(i, i + CHUNK), mode, batchId });
      if (!res.ok) {
        toast.error(res.error);
        totals.failed += Math.min(CHUNK, ok.length - i);
        totals.errors.push(res.error);
      } else {
        totals.created += res.data.created;
        totals.updated += res.data.updated;
        totals.skipped += res.data.skipped;
        totals.failed += res.data.failed;
        totals.errors.push(...res.data.errors);
      }
      setProgress(Math.min(ok.length, i + CHUNK));
    }
    setResult(totals);
    setStep("done");
    onDone();
  }

  const targets = [
    { key: SKIP, label: "— Skip —" },
    ...IMPORTABLE_FIELDS.map((f) => ({ key: f.key, label: f.label })),
    ...customFields.map((f) => ({ key: `custom.${f.key}`, label: `Custom: ${f.label}` })),
  ];

  return (
    <Dialog open={open} onOpenChange={(o) => step !== "running" && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import contacts from CSV</DialogTitle>
          <DialogDescription>
            Phones are validated and normalised to international format. Rows are matched to
            existing contacts by phone, then external ID.
          </DialogDescription>
        </DialogHeader>

        {step === "upload" && (
          <label className="hover:bg-accent/50 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-10 text-center text-sm">
            <FileUp className="text-muted-foreground size-6" />
            <span>Choose a CSV file (first row = headers)</span>
            <span className="text-muted-foreground text-xs">
              Sanoflow exports and plain spreadsheets both work.
            </span>
            <input
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])}
            />
          </label>
        )}

        {step === "map" && csv && (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              <strong>{fileName}</strong>: {csv.rows.length.toLocaleString()} rows. Match each
              column to a contact field.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {csv.headers.map((h) => (
                <div key={h} className="grid gap-1">
                  <Label className="truncate text-xs" title={h}>
                    {h}{" "}
                    <span className="text-muted-foreground font-normal">
                      e.g. {csv.rows[0]?.[csv.headers.indexOf(h)] || "—"}
                    </span>
                  </Label>
                  <Select
                    value={mapping[h] ?? SKIP}
                    onValueChange={(v) => setMapping({ ...mapping, [h]: v === SKIP ? null : v })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {targets.map((t) => (
                        <SelectItem key={t.key} value={t.key}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
            <div className="grid gap-1">
              <Label>When a contact already exists</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as "skip" | "update")}>
                <SelectTrigger className="w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="skip">Skip the row (keep existing data)</SelectItem>
                  <SelectItem value="update">Update it with non-empty values</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {step === "review" && prepared && (
          <div className="flex flex-col gap-3 text-sm">
            <div className="grid grid-cols-4 gap-2">
              <Stat label="Rows" value={prepared.summary.total} />
              <Stat label="Ready" value={prepared.summary.ok} tone="good" />
              <Stat
                label="Invalid"
                value={prepared.summary.invalid}
                tone={prepared.summary.invalid ? "bad" : undefined}
              />
              <Stat
                label="Duplicates in file"
                value={prepared.summary.duplicates}
                tone={prepared.summary.duplicates ? "warn" : undefined}
              />
            </div>
            {prepared.summary.invalid + prepared.summary.duplicates > 0 && (
              <div className="max-h-56 overflow-y-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1 text-left">Line</th>
                      <th className="px-2 py-1 text-left">Problem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {prepared.rows
                      .filter((r) => r.status !== "ok")
                      .slice(0, 200)
                      .map((r) => (
                        <tr key={r.line} className="border-t">
                          <td className="px-2 py-1 tabular-nums">{r.line}</td>
                          <td className="px-2 py-1">
                            {r.status === "duplicate"
                              ? `Duplicate of line ${r.duplicateOf} (skipped)`
                              : r.errors.join("; ")}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-muted-foreground text-xs">
              Invalid and duplicate rows are skipped. Existing contacts are{" "}
              {mode === "skip" ? "left untouched" : "updated with non-empty values"}.
            </p>
          </div>
        )}

        {step === "running" && prepared && (
          <div className="flex flex-col items-center gap-2 py-6 text-sm">
            <Loader2 className="size-5 animate-spin" />
            Importing {progress.toLocaleString()} / {prepared.summary.ok.toLocaleString()}…
          </div>
        )}

        {step === "done" && result && (
          <div className="flex flex-col gap-3 text-sm">
            <div className="grid grid-cols-4 gap-2">
              <Stat label="Created" value={result.created} tone="good" />
              <Stat label="Updated" value={result.updated} />
              <Stat label="Skipped" value={result.skipped} />
              <Stat label="Failed" value={result.failed} tone={result.failed ? "bad" : undefined} />
            </div>
            {result.errors.length > 0 && (
              <ul className="text-destructive max-h-40 list-disc overflow-y-auto pl-5 text-xs">
                {[...new Set(result.errors)].slice(0, 50).map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}

        <DialogFooter>
          {step === "map" && (
            <>
              <Button variant="ghost" onClick={() => setStep("upload")}>
                Back
              </Button>
              <Button onClick={review}>Review</Button>
            </>
          )}
          {step === "review" && (
            <>
              <Button variant="ghost" onClick={() => setStep("map")}>
                Back
              </Button>
              <Button onClick={() => void run()} disabled={!prepared || prepared.summary.ok === 0}>
                Import {prepared?.summary.ok.toLocaleString()} contacts
              </Button>
            </>
          )}
          {step === "done" && <Button onClick={() => onOpenChange(false)}>Close</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "good" | "warn" | "bad";
}) {
  const color =
    tone === "good"
      ? "text-emerald-600"
      : tone === "warn"
        ? "text-amber-600"
        : tone === "bad"
          ? "text-destructive"
          : "";
  return (
    <div className="rounded-md border p-2">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${color}`}>{value.toLocaleString()}</div>
    </div>
  );
}
