"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";

import { Field, selectClass } from "@/components/finance/forms";
import { FileUpload } from "@/components/shell/file-upload";
import { FINANCE_IMPORT_LIMITS } from "@/lib/upload/preview";

import { importReceiptRegisterAction, previewReceiptRegisterAction } from "./receipt-actions";

/**
 * Import of the insurer receipt register (one row per insurer payment). Uses the shared upload component: the preview
 * shows the layout's mapped columns only and names the other columns, never their values.
 */
export function ReceiptRegisterImport({
  formats,
}: {
  formats: Array<{ id: string; name: string }>;
}) {
  const [formatId, setFormatId] = React.useState(formats[0]?.id ?? "");
  const [summary, setSummary] = React.useState<string | null>(null);
  const layout = formats.some((f) => f.id === formatId) ? formatId : (formats[0]?.id ?? "");
  const withFile = (file: File) => {
    const fd = new FormData();
    fd.set("format_id", layout);
    fd.set("file", file);
    return fd;
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        One row per insurer payment: payment reference, amount, bank receipt date and, if you have
        them, the insurer, receipt number and bank. A payment reference already stored with the
        same figures is skipped, so month files may overlap. A reference that comes again with a
        different amount refuses the whole file. The file itself is not kept.
      </p>
      {formats.length === 0 ? (
        <p className="text-sm">
          There is no layout for this file yet.{" "}
          <Link className="underline" href="/finance/bank/settings">
            Add one in the bank settings
          </Link>{" "}
          (kind: Insurer receipt register) by naming the column headers of your file.
        </p>
      ) : (
        <Field label="Layout">
          <select
            className={selectClass}
            value={layout}
            onChange={(e) => setFormatId(e.target.value)}
          >
            {formats.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <FileUpload
        label="Receipt register"
        accept={FINANCE_IMPORT_LIMITS.extensions}
        maxBytes={FINANCE_IMPORT_LIMITS.maxBytes}
        hint="A .csv or .xlsx file up to 5 MB. Only the columns in the layout are read."
        previewKey={layout}
        disabledReason={formats.length === 0 ? "Add a layout first." : null}
        preview={(file) => previewReceiptRegisterAction(withFile(file))}
        confirmLabel="Import"
        onConfirm={async (file) => {
          const res = await importReceiptRegisterAction(withFile(file));
          if (res.ok) {
            setSummary(res.message ?? "Imported.");
            toast.success(res.message ?? "Imported");
          } else {
            setSummary(null);
            toast.error(res.error);
          }
          return res.ok;
        }}
      />
      {summary && (
        <p role="status" className="text-sm">
          {summary}
        </p>
      )}
    </div>
  );
}
