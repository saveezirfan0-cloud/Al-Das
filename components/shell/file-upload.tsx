"use client";

import * as React from "react";
import { AlertTriangle, FileSpreadsheet, Loader2, Upload, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fileProblem, formatSize, type UploadPreview } from "@/lib/upload/preview";
import { cn } from "@/lib/utils";

/**
 * The one upload component (Phase G): drag and drop or the file picker, the type and size check before anything is
 * sent, a preview of the first rows (the columns the import will read), the names of columns it will ignore, the mapped
 * columns the file is missing, and a confirm button. The parent passes its own server actions: `preview` reads the file
 * with the import's own reader and returns names and display text only; `onConfirm` runs the unchanged import.
 *
 * Accessible: the drop area is a convenience, "Choose file" is a real button (keyboard and screen readers), the status
 * line is an aria-live region, and the preview is a plain table with a caption.
 */

type Result<T> = { ok: true; data?: T; message?: string } | { ok: false; error: string };

type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: UploadPreview }
  | { status: "error"; error: string };

export function FileUpload({
  label,
  accept,
  maxBytes,
  hint,
  preview,
  previewKey,
  confirmLabel = "Import",
  onConfirm,
  disabledReason,
  className,
}: {
  label: string;
  /** Lower-case extensions with the dot, e.g. [".csv", ".xlsx"]. */
  accept: readonly string[];
  maxBytes: number;
  hint?: string;
  /** Reads the file on the server and returns the preview (nothing stored). */
  preview?: (file: File) => Promise<Result<UploadPreview>>;
  /** Changes when the preview depends on other fields (the layout, the provider): the preview runs again. */
  previewKey?: string;
  confirmLabel?: string;
  /** Runs the import; true when it is done (the component then clears itself). */
  onConfirm: (file: File) => Promise<boolean>;
  /** When set, nothing can be chosen and this says why (e.g. no layout yet). */
  disabledReason?: string | null;
  className?: string;
}) {
  const inputId = React.useId();
  const statusId = React.useId();
  const input = React.useRef<HTMLInputElement>(null);
  const [file, setFile] = React.useState<File | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [state, setState] = React.useState<PreviewState>({ status: "idle" });
  const [dragging, setDragging] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const run = React.useRef(0);
  const disabled = !!disabledReason;

  const limits = React.useMemo(() => ({ extensions: accept, maxBytes }), [accept, maxBytes]);

  const clear = React.useCallback(() => {
    run.current++;
    setFile(null);
    setProblem(null);
    setState({ status: "idle" });
    if (input.current) input.current.value = "";
  }, []);

  const choose = (f: File | null | undefined) => {
    if (!f || disabled) return;
    const why = fileProblem(f, limits);
    setFile(why ? null : f);
    setProblem(why);
    setState({ status: "idle" });
    if (input.current) input.current.value = "";
  };

  // the latest preview action, without re-reading the file each time the parent re-renders
  const previewRef = React.useRef(preview);
  React.useEffect(() => {
    previewRef.current = preview;
  });
  const hasPreview = preview !== undefined;

  // read the preview whenever the file or what it depends on (the layout) changes; a later run wins
  React.useEffect(() => {
    const read = previewRef.current;
    if (!file || !read) return;
    const mine = ++run.current;
    setState({ status: "loading" });
    read(file)
      .then((res) => {
        if (run.current !== mine) return;
        setState(
          res.ok && res.data
            ? { status: "ready", data: res.data }
            : { status: "error", error: res.ok ? "The file could not be read." : res.error },
        );
      })
      .catch(() => {
        if (run.current === mine)
          setState({ status: "error", error: "The file could not be read. Try again." });
      });
  }, [file, hasPreview, previewKey]);

  const data = state.status === "ready" ? state.data : null;
  const blocked =
    !file ||
    busy ||
    disabled ||
    (hasPreview && state.status !== "ready") ||
    (data !== null && (data.missing.length > 0 || data.dataRows === 0));

  const status = disabledReason
    ? disabledReason
    : problem
      ? problem
      : !file
        ? "No file chosen."
        : busy
          ? "Importing…"
          : state.status === "loading"
            ? "Reading the file…"
            : state.status === "error"
              ? state.error
              : data
                ? data.missing.length > 0
                  ? `The file is missing ${data.missing.length} column(s) the layout needs. Nothing can be imported.`
                  : data.dataRows === 0
                    ? "The file has no data rows."
                    : `Ready: ${data.dataRows} data row(s) found${data.unknown.length + data.unknownMore > 0 ? `, ${data.unknown.length + data.unknownMore} column(s) will be ignored` : ""}. Check the preview, then ${confirmLabel.toLowerCase()}.`
                : `${formatSize(file.size)} chosen.`;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <span className="text-sm font-medium" id={`${inputId}-label`}>
        {label}
      </span>
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center text-sm transition-colors motion-reduce:transition-none",
          dragging ? "border-primary bg-primary/5" : "border-input",
          disabled && "opacity-60",
        )}
        onDragOver={(e) => {
          if (disabled) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          choose(e.dataTransfer.files?.[0]);
        }}
      >
        <Upload className="text-muted-foreground size-6" aria-hidden />
        <p className="text-muted-foreground">
          Drag a {accept.join(" or ")} file here, or
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || busy}
          aria-describedby={statusId}
          onClick={() => input.current?.click()}
        >
          Choose file
        </Button>
        <input
          ref={input}
          id={inputId}
          type="file"
          accept={accept.join(",")}
          className="sr-only"
          tabIndex={-1}
          aria-labelledby={`${inputId}-label`}
          disabled={disabled}
          onChange={(e) => choose(e.target.files?.[0])}
        />
        {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      </div>

      {file && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <FileSpreadsheet className="text-muted-foreground size-4" aria-hidden />
          <span className="max-w-[16rem] truncate font-medium">{file.name}</span>
          <span className="text-muted-foreground">{formatSize(file.size)}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            disabled={busy}
            onClick={clear}
            aria-label="Remove the chosen file"
          >
            <X aria-hidden /> Remove
          </Button>
        </div>
      )}

      <p
        id={statusId}
        role="status"
        aria-live="polite"
        className={cn(
          "text-sm",
          problem || state.status === "error" || (data && data.missing.length > 0)
            ? "text-destructive"
            : "text-muted-foreground",
        )}
      >
        {state.status === "loading" || busy ? (
          <Loader2 className="mr-1 inline size-4 animate-spin" aria-hidden />
        ) : null}
        {status}
      </p>

      {data && data.missing.length > 0 && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200">
          <p className="font-medium">Missing columns</p>
          <ul className="list-disc pl-5">
            {data.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      {data && data.unknown.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <p className="flex items-center gap-1 font-medium">
            <AlertTriangle className="size-4" aria-hidden /> Columns that will be ignored
          </p>
          <p className="text-xs">
            The layout does not use these columns, so their contents are never read or stored.
          </p>
          <ul className="mt-1 flex flex-wrap gap-1">
            {data.unknown.map((u) => (
              <li key={u}>
                <Badge variant="warning">{u}</Badge>
              </li>
            ))}
            {data.unknownMore > 0 && (
              <li>
                <Badge variant="outline">and {data.unknownMore} more</Badge>
              </li>
            )}
          </ul>
        </div>
      )}

      {data && data.columns.length > 0 && data.rows.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <caption className="text-muted-foreground px-3 py-2 text-left text-xs">
              The first {data.rows.length} of {data.dataRows} row(s), as they will be read (header on
              row {data.headerRow}).
            </caption>
            <TableHeader>
              <TableRow>
                {data.columns.map((c) => (
                  <TableHead key={c.field} scope="col">
                    {c.label}
                    <span className="text-muted-foreground block text-xs font-normal">
                      {c.header}
                    </span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((r, i) => (
                <TableRow key={i}>
                  {r.map((v, j) => (
                    <TableCell key={j} className="whitespace-nowrap">
                      {v || <span className="text-muted-foreground">blank</span>}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={blocked}
          onClick={async () => {
            if (!file) return;
            setBusy(true);
            try {
              if (await onConfirm(file)) clear();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Upload aria-hidden />}{" "}
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
