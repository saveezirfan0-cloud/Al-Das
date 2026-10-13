"use client";

import { useRouter } from "next/navigation";

import { ActionForm, Field, FormSheet, RunButton } from "@/components/finance/forms";
import { Input } from "@/components/ui/input";

import {
  discardSalesDoc,
  issueSalesDoc,
  retryReceivablePostings,
  voidSalesInvoice,
} from "./actions";

/** The buttons on a sales document. Each server action checks the permission again; the database decides the rest. */

export function IssueSalesDoc({
  id,
  hash,
  approve,
  label,
}: {
  id: string;
  hash: string | null;
  approve: boolean;
  label: string;
}) {
  const router = useRouter();
  return (
    <RunButton
      variant="default"
      confirm={
        approve
          ? "Approve and issue this document as it is shown? It gets its number and is posted; it can then only be voided by a credit note."
          : "Issue this document? It gets its number and is posted; it can then only be voided by a credit note."
      }
      action={() => issueSalesDoc({ id, hash })}
      onDone={() => router.refresh()}
    >
      {label}
    </RunButton>
  );
}

export function DiscardSalesDoc({ id, back }: { id: string; back: string }) {
  const router = useRouter();
  return (
    <RunButton
      variant="ghost"
      confirm="Delete this draft? This cannot be undone."
      action={() => discardSalesDoc({ id })}
      onDone={() => router.push(back)}
    >
      Delete draft
    </RunButton>
  );
}

export function VoidSalesInvoice({ id, defaultDate }: { id: string; defaultDate: string }) {
  const router = useRouter();
  return (
    <FormSheet
      trigger="Void"
      title="Void this invoice"
      description="Issues a credit note for the full amount on the date you choose; it reverses the income, the VAT and the receivable. The invoice keeps its number and shows as void."
      variant="outline"
      size="sm"
    >
      {(close) => (
        <ActionForm
          action={async (v) => {
            const res = await voidSalesInvoice({ id, date: v.date ?? "", reason: v.reason ?? "" });
            if (res.ok && res.data) router.push(`/accounting/sales-invoices/${res.data.creditNoteId}`);
            return res;
          }}
          submitLabel="Void"
          variant="destructive"
          onDone={() => {
            close();
            router.refresh();
          }}
        >
          <Field label="Credit note date" hint="On or after the invoice date, in an open period.">
            <Input type="date" name="date" defaultValue={defaultDate} required />
          </Field>
          <Field label="Reason">
            <Input name="reason" minLength={3} maxLength={200} required />
          </Field>
        </ActionForm>
      )}
    </FormSheet>
  );
}

export function RetryPostings() {
  const router = useRouter();
  return (
    <RunButton action={() => retryReceivablePostings()} onDone={() => router.refresh()}>
      Post waiting documents
    </RunButton>
  );
}
