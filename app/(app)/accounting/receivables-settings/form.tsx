"use client";

import { useRouter } from "next/navigation";

import { ActionForm, Field } from "@/components/finance/forms";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { saveArSettings } from "./actions";

export type ArSettingsValue = {
  issue_approval_threshold: number;
  simplified_invoice_limit: number;
  credit_note_days: number;
  invoice_prefix: string;
  credit_note_prefix: string;
  receipt_prefix: string;
  seller_address: string | null;
  payment_instructions: string | null;
};

export function ArSettingsForm({ value, canEdit }: { value: ArSettingsValue; canEdit: boolean }) {
  const router = useRouter();
  return (
    <ActionForm action={saveArSettings} onDone={() => router.refresh()} disabled={!canEdit}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          label="Approval limit (AED)"
          hint="A sales invoice or credit note above this total is issued by a second person with the journal approval permission."
        >
          <Input
            type="number"
            name="issue_approval_threshold"
            min={0}
            step="0.01"
            defaultValue={value.issue_approval_threshold}
            required
          />
        </Field>
        <Field label="Simplified invoice limit (AED)" hint="At most AED 10,000 (FTA). Only for customers without a TRN.">
          <Input
            type="number"
            name="simplified_invoice_limit"
            min={0}
            max={10000}
            step="0.01"
            defaultValue={value.simplified_invoice_limit}
            required
          />
        </Field>
        <Field label="Credit note warning (days)" hint="Warn when a credit note comes later than this after its event (FTA: 14).">
          <Input
            type="number"
            name="credit_note_days"
            min={1}
            max={365}
            defaultValue={value.credit_note_days}
            required
          />
        </Field>
        <Field label="Invoice prefix">
          <Input name="invoice_prefix" maxLength={6} defaultValue={value.invoice_prefix} required />
        </Field>
        <Field label="Credit note prefix">
          <Input name="credit_note_prefix" maxLength={6} defaultValue={value.credit_note_prefix} required />
        </Field>
        <Field label="Receipt prefix">
          <Input name="receipt_prefix" maxLength={6} defaultValue={value.receipt_prefix} required />
        </Field>
      </div>
      <Field label="Seller address" hint="Printed under the entity's name and TRN on every tax invoice.">
        <Textarea name="seller_address" maxLength={300} rows={3} defaultValue={value.seller_address ?? ""} />
      </Field>
      <Field label="How to pay" hint="The clinic's bank details, printed on invoices and statements.">
        <Textarea
          name="payment_instructions"
          maxLength={500}
          rows={3}
          defaultValue={value.payment_instructions ?? ""}
        />
      </Field>
    </ActionForm>
  );
}
