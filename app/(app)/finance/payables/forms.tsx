"use client";

import * as React from "react";

import { ActionForm, Field, FormSheet, RunButton, selectClass } from "@/components/finance/forms";
import {
  DocumentChip,
  FinanceUploadButton,
  type UploadedDocument,
} from "@/components/finance/finance-upload";
import { Input } from "@/components/ui/input";

import { saveSupplier, saveSupplierInvoice, voidSupplierInvoice } from "./actions";

export type SupplierView = {
  id: string;
  name: string;
  trn: string | null;
  default_category: string | null;
  payment_terms_days: number | null;
  active: boolean;
};

function SupplierFields({ s }: { s?: SupplierView }) {
  return (
    <>
      {s && <input type="hidden" name="id" value={s.id} />}
      <Field label="Name">
        <Input name="name" defaultValue={s?.name ?? ""} maxLength={120} required />
      </Field>
      <Field label="Tax registration number (TRN)" hint="Optional.">
        <Input name="trn" defaultValue={s?.trn ?? ""} maxLength={20} />
      </Field>
      <Field
        label="Default expense category"
        hint="Suggested on its invoices and vouchers (for example Consumables)."
      >
        <Input name="default_category" defaultValue={s?.default_category ?? ""} maxLength={60} />
      </Field>
      <Field label="Payment terms (days)">
        <Input
          name="payment_terms_days"
          inputMode="numeric"
          defaultValue={s?.payment_terms_days ?? ""}
        />
      </Field>
      {s && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="active" defaultChecked={s.active} /> Active
        </label>
      )}
    </>
  );
}

export function SupplierButton({ supplier }: { supplier?: SupplierView }) {
  return (
    <FormSheet
      trigger={supplier ? "Edit" : "Add supplier"}
      title={supplier ? "Edit supplier" : "Add a supplier"}
      variant={supplier ? "ghost" : "default"}
      size="sm"
    >
      {(close) => (
        <ActionForm action={saveSupplier} submitLabel="Save supplier" onDone={close}>
          <SupplierFields s={supplier} />
        </ActionForm>
      )}
    </FormSheet>
  );
}

export type InvoiceView = {
  id: string;
  supplier_id: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string | null;
  category: string;
  net: number;
  vat: number;
  branch_code: string | null;
  cost_centre: string | null;
  doctor_dha_id: string | null;
  document: UploadedDocument | null;
};

export type InvoiceOptions = {
  suppliers: Array<{ id: string; name: string; default_category: string | null }>;
  branches: Array<{ code: string; name: string }>;
  categories: string[];
  today: string;
};

function InvoiceForm({
  invoice,
  options,
  onDone,
}: {
  invoice?: InvoiceView;
  options: InvoiceOptions;
  onDone: () => void;
}) {
  const [doc, setDoc] = React.useState<UploadedDocument | null>(invoice?.document ?? null);
  const [category, setCategory] = React.useState(invoice?.category ?? "");
  return (
    <ActionForm action={saveSupplierInvoice} submitLabel="Save invoice" onDone={onDone}>
      {invoice && <input type="hidden" name="id" value={invoice.id} />}
      <input type="hidden" name="document_id" value={doc?.id ?? ""} />
      <Field label="Supplier">
        <select
          name="supplier_id"
          className={selectClass}
          defaultValue={invoice?.supplier_id ?? ""}
          required
          onChange={(e) => {
            const s = options.suppliers.find((x) => x.id === e.target.value);
            if (s?.default_category && !category) setCategory(s.default_category);
          }}
        >
          <option value="" disabled>
            Choose a supplier
          </option>
          {options.suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Invoice number">
          <Input
            name="invoice_number"
            defaultValue={invoice?.invoice_number ?? ""}
            maxLength={60}
            required
          />
        </Field>
        <Field label="Category">
          <Input
            name="category"
            list="invoice-categories"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            maxLength={60}
            required
          />
          <datalist id="invoice-categories">
            {options.categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>
        <Field label="Invoice date">
          <Input
            type="date"
            name="invoice_date"
            defaultValue={invoice?.invoice_date ?? options.today}
            required
          />
        </Field>
        <Field label="Due date">
          <Input type="date" name="due_date" defaultValue={invoice?.due_date ?? ""} />
        </Field>
        <Field label="Net (AED)">
          <Input
            name="net"
            inputMode="decimal"
            defaultValue={invoice ? invoice.net.toFixed(2) : ""}
            required
          />
        </Field>
        <Field label="VAT (AED)">
          <Input
            name="vat"
            inputMode="decimal"
            defaultValue={invoice ? invoice.vat.toFixed(2) : "0.00"}
          />
        </Field>
        <Field label="Branch (cost centre)">
          <select
            name="branch_code"
            className={selectClass}
            defaultValue={invoice?.branch_code ?? ""}
          >
            <option value="">None</option>
            {options.branches.map((b) => (
              <option key={b.code} value={b.code}>
                {b.name} ({b.code})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Other cost centre">
          <Input name="cost_centre" defaultValue={invoice?.cost_centre ?? ""} maxLength={40} />
        </Field>
        <Field
          label="Doctor (DHA id, optional)"
          hint="When the cost belongs to one doctor (lab or referral costs)."
        >
          <Input name="doctor_dha_id" defaultValue={invoice?.doctor_dha_id ?? ""} maxLength={40} />
        </Field>
      </div>
      <Field
        label="The invoice itself"
        hint="PDF from the accounts mailbox, or a photo of the paper copy."
      >
        <div className="flex flex-col gap-2">
          {doc ? (
            <DocumentChip doc={doc} onRemove={() => setDoc(null)} />
          ) : (
            <div>
              <FinanceUploadButton
                kind="supplier_invoice"
                label="Attach the invoice"
                onUploaded={setDoc}
              />
            </div>
          )}
        </div>
      </Field>
    </ActionForm>
  );
}

export function InvoiceButton({
  invoice,
  options,
}: {
  invoice?: InvoiceView;
  options: InvoiceOptions;
}) {
  return (
    <FormSheet
      trigger={invoice ? "Edit" : "Add invoice"}
      title={invoice ? "Edit supplier invoice" : "Add a supplier invoice"}
      description="The document is stored in Pulse and travels with any voucher that pays it."
      variant={invoice ? "ghost" : "default"}
      size="sm"
    >
      {(close) => <InvoiceForm invoice={invoice} options={options} onDone={close} />}
    </FormSheet>
  );
}

export function VoidInvoiceButton({ id }: { id: string }) {
  return (
    <RunButton
      variant="ghost"
      action={() => voidSupplierInvoice({ id })}
      confirm="Void this invoice? It stays on record but can no longer be paid or exported."
    >
      Void
    </RunButton>
  );
}
