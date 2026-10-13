"use client";

import { useRouter } from "next/navigation";

import { ActionForm, Field, FormSheet } from "@/components/finance/forms";
import { Input } from "@/components/ui/input";

import { voidReceipt } from "./actions";

export function VoidReceipt({ id, defaultDate }: { id: string; defaultDate: string }) {
  const router = useRouter();
  return (
    <FormSheet
      trigger="Void"
      title="Void this receipt"
      description="For a bounced cheque or a wrong entry. The receipt's journal is reversed on the date you choose and the invoices it paid are open again."
      variant="outline"
      size="sm"
    >
      {(close) => (
        <ActionForm
          action={(v) => voidReceipt({ id, date: v.date ?? "", reason: v.reason ?? "" })}
          submitLabel="Void"
          variant="destructive"
          onDone={() => {
            close();
            router.refresh();
          }}
        >
          <Field label="Reversal date" hint="On or after the receipt date, in an open period.">
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
