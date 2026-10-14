"use client";

import * as React from "react";
import { FileUp, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { OptionSelect } from "@/app/(app)/enquiries/option-select";
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
import { parseCsv, type ParsedCsv } from "@/lib/csv";
import {
  ENQUIRY_IMPORT_FIELDS,
  MAX_IMPORT_ROWS,
  guessMapping,
  mappingProblem,
  type EnquiryImportField,
} from "@/lib/enquiries/csv-import";
import type { PipelineInfo } from "@/lib/enquiries/server";

import {
  previewEnquiryImport,
  runEnquiryImportChunk,
  type ImportChunkCounts,
  type PreviewRow,
  type PreviewSummary,
} from "./import-actions";

const CHUNK = 50;
const SKIP = "__skip__";

type Step = "file" | "map" | "preview" | "done";

/**
 * Enquiries CSV import (Phase F): pick a file, match its columns, check a dry run with the problems per row, then
 * import. Re-importing the same file creates nothing twice (each row's key is remembered).
 */
export function EnquiryImportDialog({
  open,
  onOpenChange,
  pipelines,
  defaultPipelineId,
  onImported,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  pipelines: PipelineInfo[];
  defaultPipelineId: string | null;
  onImported: () => void;
}) {
  const [step, setStep] = React.useState<Step>("file");
  const [fileName, setFileName] = React.useState("");
  const [csv, setCsv] = React.useState<ParsedCsv | null>(null);
  const [mapping, setMapping] = React.useState<Record<string, EnquiryImportField | null>>({});
  const [pipelineId, setPipelineId] = React.useState<string | null>(defaultPipelineId);
  const [preview, setPreview] = React.useState<{
    rows: PreviewRow[];
    summary: PreviewSummary;
  } | null>(null);
  const [progress, setProgress] = React.useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = React.useState<ImportChunkCounts | null>(null);
  const [pending, startTransition] = React.useTransition();
  const live = pipelines.filter((p) => !p.archived);

  React.useEffect(() => {
    if (!open) return;
    setStep("file");
    setFileName("");
    setCsv(null);
    setMapping({});
    setPreview(null);
    setProgress(null);
    setResult(null);
    setPipelineId(defaultPipelineId ?? live[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function onFile(file: File) {
    const text = await file.text();
    const parsed = parseCsv(text);
    if (parsed.headers.length === 0 || parsed.rows.length === 0)
      return void toast.error("The file needs a header row and at least one row.");
    if (parsed.rows.length > MAX_IMPORT_ROWS)
      return void toast.error(`Import at most ${MAX_IMPORT_ROWS} rows at a time; split the file.`);
    setFileName(file.name);
    setCsv(parsed);
    setMapping(guessMapping(parsed.headers));
    setStep("map");
  }

  const problem = csv ? mappingProblem(mapping) : null;
  const payload = () => ({
    headers: csv!.headers,
    rows: csv!.rows,
    mapping,
    pipeline_id: pipelineId!,
  });

  function runPreview() {
    if (!csv || !pipelineId) return;
    startTransition(async () => {
      const r = await previewEnquiryImport(payload());
      if (!r.ok) return void toast.error(r.error);
      setPreview(r.data);
      setStep("preview");
    });
  }

  function runImport() {
    if (!csv || !pipelineId) return;
    const batchId = `csv-${Date.now().toString(36)}`;
    startTransition(async () => {
      const totals: ImportChunkCounts = { created: 0, skipped: 0, failed: 0, contactsCreated: 0 };
      setProgress({ done: 0, total: csv.rows.length });
      for (let offset = 0; offset < csv.rows.length; offset += CHUNK) {
        const r = await runEnquiryImportChunk({
          ...payload(),
          batch_id: batchId,
          offset,
          limit: CHUNK,
        });
        if (!r.ok) {
          toast.error(r.error);
          break;
        }
        totals.created += r.data.created;
        totals.skipped += r.data.skipped;
        totals.failed += r.data.failed;
        totals.contactsCreated += r.data.contactsCreated;
        setProgress({ done: Math.min(offset + CHUNK, csv.rows.length), total: csv.rows.length });
      }
      setResult(totals);
      setStep("done");
      onImported();
    });
  }

  const problems =
    preview?.rows.filter((r) => r.status === "invalid" || r.status === "duplicate") ?? [];

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import enquiries from a CSV file</DialogTitle>
          <DialogDescription>
            One enquiry per row. Phones are matched to existing patients (new ones are added if you
            may add patients). Running the same file again does not create anything twice.
          </DialogDescription>
        </DialogHeader>

        {step === "file" && (
          <label className="hover:bg-muted/50 flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed p-8 text-center text-sm">
            <FileUp className="text-muted-foreground size-6" aria-hidden />
            Choose a .csv file (at most {MAX_IMPORT_ROWS.toLocaleString()} rows)
            <input
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
              }}
            />
          </label>
        )}

        {step === "map" && csv && (
          <div className="grid gap-3">
            <p className="text-sm">
              <strong>{fileName}</strong>: {csv.rows.length.toLocaleString()} rows. Match each
              column to a field, or skip it (skipped columns are not read).
            </p>
            <div className="grid gap-1.5">
              <Label htmlFor="imp-pipeline">Pipeline for rows without one</Label>
              <OptionSelect
                id="imp-pipeline"
                allowNone={false}
                value={pipelineId}
                options={live.map((p) => ({ value: p.id, label: p.name }))}
                onChange={setPipelineId}
              />
            </div>
            <div className="grid gap-2 rounded-lg border p-3">
              {csv.headers.map((h) => (
                <div
                  key={h}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-3 text-sm"
                >
                  <span className="truncate font-medium" title={h}>
                    {h}
                  </span>
                  <OptionSelect
                    ariaLabel={`Field for ${h}`}
                    allowNone={false}
                    value={mapping[h] ?? SKIP}
                    options={[
                      { value: SKIP, label: "Skip this column" },
                      ...ENQUIRY_IMPORT_FIELDS.map((f) => ({ value: f.key, label: f.label })),
                    ]}
                    onChange={(v) =>
                      setMapping((m) => ({
                        ...m,
                        [h]: v && v !== SKIP ? (v as EnquiryImportField) : null,
                      }))
                    }
                  />
                </div>
              ))}
            </div>
            {problem && <p className="text-destructive text-sm">{problem}</p>}
            <DialogFooter>
              <Button variant="ghost" onClick={() => setStep("file")}>
                Back
              </Button>
              <Button onClick={runPreview} disabled={pending || !!problem || !pipelineId}>
                {pending && <Loader2 className="animate-spin" />} Check the rows
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === "preview" && preview && (
          <div className="grid gap-3">
            <ul className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <li className="rounded-lg border p-2">
                <span className="block text-lg font-semibold tabular-nums">
                  {preview.summary.ok}
                </span>{" "}
                ready
              </li>
              <li className="rounded-lg border p-2">
                <span className="block text-lg font-semibold tabular-nums">
                  {preview.summary.exists}
                </span>{" "}
                imported before
              </li>
              <li className="rounded-lg border p-2">
                <span className="block text-lg font-semibold tabular-nums">
                  {preview.summary.duplicates}
                </span>{" "}
                repeated in the file
              </li>
              <li className="rounded-lg border p-2">
                <span className="block text-lg font-semibold tabular-nums">
                  {preview.summary.invalid}
                </span>{" "}
                with problems
              </li>
            </ul>
            {problems.length > 0 && (
              <div className="max-h-64 overflow-y-auto rounded-lg border">
                <table className="w-full text-sm">
                  <caption className="sr-only">Rows that will not be imported</caption>
                  <thead>
                    <tr className="text-muted-foreground border-b text-left text-xs">
                      <th className="px-3 py-1.5 font-medium">Row</th>
                      <th className="px-3 py-1.5 font-medium">Why it is skipped</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {problems.slice(0, 200).map((r) => (
                      <tr key={r.line}>
                        <td className="px-3 py-1.5 tabular-nums">{r.line + 1}</td>
                        <td className="px-3 py-1.5">
                          {r.status === "duplicate"
                            ? `Same as row ${(r.duplicateOf ?? 0) + 1}`
                            : r.errors.join(" ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {problems.length > 200 && (
                  <p className="text-muted-foreground px-3 py-2 text-xs">
                    Showing the first 200 problems.
                  </p>
                )}
              </div>
            )}
            <p className="text-muted-foreground text-xs">
              Row numbers count the header as row 1, like a spreadsheet.
            </p>
            {progress && (
              <p className="text-sm" role="status">
                Importing… {progress.done.toLocaleString()} of {progress.total.toLocaleString()}{" "}
                rows checked
              </p>
            )}
            <DialogFooter>
              <Button variant="ghost" disabled={pending} onClick={() => setStep("map")}>
                Back
              </Button>
              <Button onClick={runImport} disabled={pending || preview.summary.ok === 0}>
                {pending && <Loader2 className="animate-spin" />} Import{" "}
                {preview.summary.ok.toLocaleString()} enquiries
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === "done" && result && (
          <div className="grid gap-3 text-sm" role="status">
            <p>
              <strong>{result.created.toLocaleString()}</strong> enquiries created
              {result.contactsCreated
                ? `, ${result.contactsCreated.toLocaleString()} new patients`
                : ""}
              . {result.skipped.toLocaleString()} skipped (already imported or repeated),{" "}
              {result.failed.toLocaleString()} not imported (problems in the row, or a phone shared
              by several patients).
            </p>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Close</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
