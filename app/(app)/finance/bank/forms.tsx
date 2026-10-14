"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { ActionForm, Field, RunButton, selectClass } from "@/components/finance/forms";
import { FileUpload } from "@/components/shell/file-upload";
import { Input } from "@/components/ui/input";
import { FINANCE_IMPORT_LIMITS } from "@/lib/upload/preview";

import { createRun, deleteImport, importStatement, previewStatement } from "./actions";

type Option = { id: string; label: string };
export type FormatOption = { id: string; kind: string; name: string };

export function ImportForm({
  accounts,
  formats,
  modes,
}: {
  accounts: Option[];
  formats: FormatOption[];
  modes: string[];
}) {
  const [kind, setKind] = React.useState<"bank_statement" | "settlement">("bank_statement");
  const layouts = formats.filter((f) => f.kind === kind);
  const [formatId, setFormatId] = React.useState(layouts[0]?.id ?? "");
  const form = React.useRef<HTMLFormElement>(null);
  // the chosen layout must belong to the kind; fall back to the kind's first layout
  const layout = layouts.some((f) => f.id === formatId) ? formatId : (layouts[0]?.id ?? "");
  /** The form's fields plus the dropped file, as the server actions take them. */
  const withFile = (file: File) => {
    const fd = new FormData(form.current ?? undefined);
    fd.set("format_id", layout);
    fd.set("file", file);
    return fd;
  };
  return (
    <form
      ref={form}
      className="flex flex-col gap-3"
      onSubmit={(e) => e.preventDefault()}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="What is it?">
          <select
            name="kind"
            className={selectClass}
            value={kind}
            onChange={(e) => setKind(e.target.value as "bank_statement" | "settlement")}
          >
            <option value="bank_statement">Bank statement</option>
            <option value="settlement">Processor settlement report</option>
          </select>
        </Field>
        <Field
          label="Layout"
          hint={
            layouts.length === 0
              ? "Add a layout for this kind of file in Settings first."
              : undefined
          }
        >
          <select
            name="format_id"
            className={selectClass}
            value={layout}
            onChange={(e) => setFormatId(e.target.value)}
            required
          >
            {layouts.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </Field>
        {kind === "bank_statement" ? (
          <Field label="Bank account">
            <select name="account_id" className={selectClass} required>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label="Payment mode">
            <select name="payment_mode" className={selectClass} required>
              {modes.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <FileUpload
        label="File"
        accept={FINANCE_IMPORT_LIMITS.extensions}
        maxBytes={FINANCE_IMPORT_LIMITS.maxBytes}
        hint="A .csv or .xlsx file up to 5 MB. Only the columns in the layout are read; the file itself is not kept."
        previewKey={`${kind}:${layout}`}
        disabledReason={layouts.length === 0 ? "Add a layout for this kind of file first." : null}
        preview={(file) => previewStatement(withFile(file))}
        confirmLabel="Import"
        onConfirm={async (file) => {
          const res = await importStatement(withFile(file));
          if (res.ok) toast.success(res.message ?? "Imported");
          else toast.error(res.error);
          return res.ok;
        }}
      />
    </form>
  );
}

export function NewRunForm({ accounts, month }: { accounts: Option[]; month: string }) {
  const router = useRouter();
  return (
    <ActionForm
      action={async (values) => {
        const res = await createRun(values);
        if (res.ok && res.data) router.push(`/finance/bank/${res.data.id}`);
        return res;
      }}
      submitLabel="Open reconciliation"
      className="sm:flex-row sm:items-end"
    >
      <Field label="Account" className="sm:w-64">
        <select name="account_id" className={selectClass} required>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Month" className="sm:w-44">
        <Input type="month" name="month" defaultValue={month} required />
      </Field>
    </ActionForm>
  );
}

export function RemoveImportButton({ id }: { id: string }) {
  return (
    <RunButton
      variant="ghost"
      confirm="Remove this import and all its lines? Matched lines must be undone first."
      action={() => deleteImport({ id })}
    >
      Remove
    </RunButton>
  );
}
