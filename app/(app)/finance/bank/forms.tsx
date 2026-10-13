"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import { ActionForm, Field, RunButton, selectClass } from "@/components/finance/forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { createRun, deleteImport, importStatement } from "./actions";

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
  const [pending, start] = React.useTransition();
  const form = React.useRef<HTMLFormElement>(null);
  const layouts = formats.filter((f) => f.kind === kind);
  return (
    <form
      ref={form}
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        start(async () => {
          const res = await importStatement(fd);
          if (res.ok) {
            toast.success(res.message ?? "Imported");
            form.current?.reset();
          } else toast.error(res.error);
        });
      }}
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
          <select name="format_id" className={selectClass} required>
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
        <Field label="File (.csv or .xlsx, up to 5 MB)">
          <Input name="file" type="file" accept=".csv,.xlsx" required />
        </Field>
      </div>
      <div>
        <Button type="submit" disabled={pending || layouts.length === 0}>
          {pending ? <Loader2 className="animate-spin" /> : <Upload />} Import
        </Button>
      </div>
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
