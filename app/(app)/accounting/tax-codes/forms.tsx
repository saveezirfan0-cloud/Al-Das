"use client";

import { useRouter } from "next/navigation";

import { ActionForm, Field, FormSheet, selectClass } from "@/components/finance/forms";
import { Input } from "@/components/ui/input";
import { TAX_KIND_LABELS, TAX_KINDS } from "@/lib/accounting/tax";

import { saveTaxCode } from "./actions";

export type TaxCodeView = {
  id: string;
  code: string;
  name: string;
  rate: number;
  kind: string;
  output_account_id: string | null;
  input_account_id: string | null;
  active: boolean;
};

export function TaxCodeButton({
  tax,
  accounts,
}: {
  tax?: TaxCodeView;
  accounts: Array<{ id: string; label: string }>;
}) {
  const router = useRouter();
  const accountSelect = (name: string, value: string | null | undefined) => (
    <select name={name} className={selectClass} defaultValue={value ?? ""}>
      <option value="">None</option>
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.label}
        </option>
      ))}
    </select>
  );
  return (
    <FormSheet
      trigger={tax ? "Edit" : "Add tax code"}
      title={tax ? `Edit ${tax.code}` : "Add a tax code"}
      description="Which service is which is the tax adviser's decision; Pulse never guesses a tax code."
      variant={tax ? "ghost" : "default"}
      size="sm"
    >
      {(close) => (
        <ActionForm
          action={saveTaxCode}
          onDone={() => {
            close();
            router.refresh();
          }}
        >
          {tax && <input type="hidden" name="id" value={tax.id} />}
          <Field label="Code">
            <Input name="code" defaultValue={tax?.code ?? ""} maxLength={12} required />
          </Field>
          <Field label="Name">
            <Input name="name" defaultValue={tax?.name ?? ""} maxLength={80} required />
          </Field>
          <Field label="Kind">
            <select name="kind" className={selectClass} defaultValue={tax?.kind ?? "standard"}>
              {TAX_KINDS.map((k) => (
                <option key={k} value={k}>
                  {TAX_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Rate (%)">
            <Input
              name="rate"
              inputMode="decimal"
              defaultValue={tax ? String(tax.rate) : "5"}
              required
            />
          </Field>
          <Field label="Output VAT account">
            {accountSelect("output_account_id", tax?.output_account_id)}
          </Field>
          <Field label="Input VAT account">
            {accountSelect("input_account_id", tax?.input_account_id)}
          </Field>
          {tax && (
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" name="active" defaultChecked={tax.active} /> Active
            </label>
          )}
        </ActionForm>
      )}
    </FormSheet>
  );
}
