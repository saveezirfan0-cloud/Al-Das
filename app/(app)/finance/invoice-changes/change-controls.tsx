"use client";

import { useRouter } from "next/navigation";

import { ActionForm, Field, FormSheet, selectClass } from "@/components/finance/forms";
import { Textarea } from "@/components/ui/textarea";
import { DECISION_LABELS, DECISIONS, REASON_MAX } from "@/lib/finance/invoice-changes";

import { bulkApproveChanges, reviewChange } from "./actions";

export { ClaimDrawer as ChangeDrawer } from "../followup/followup-controls";

const REASON_HINT =
  "Who authorised it and why (for example the approval reference). No patient names, card or phone numbers.";

export function ReviewForm({
  changeKey,
  changeDate,
  closeHref,
}: {
  changeKey: string;
  changeDate: string;
  closeHref: string;
}) {
  const router = useRouter();
  return (
    <ActionForm
      action={(v) => reviewChange({ ...v, change_key: changeKey, change_date: changeDate })}
      submitLabel="Save review"
      onDone={() => router.push(closeHref, { scroll: false })}
    >
      <Field label="Decision">
        <select name="decision" className={selectClass} defaultValue="approved">
          {DECISIONS.map((d) => (
            <option key={d} value={d}>
              {DECISION_LABELS[d]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Reason" hint={REASON_HINT}>
        <Textarea name="reason" maxLength={REASON_MAX} rows={3} required />
      </Field>
    </ActionForm>
  );
}

export function BulkApprove({
  from,
  to,
  kind,
  count,
  label,
}: {
  from: string;
  to: string;
  kind: string | null;
  count: number;
  label: string;
}) {
  const router = useRouter();
  return (
    <FormSheet
      trigger={`Approve ${count} small change(s)`}
      title="Approve small changes together"
      description={label}
      variant="outline"
      size="sm"
    >
      {(close) => (
        <ActionForm
          action={(v) => bulkApproveChanges({ ...v, from, to, kind: kind ?? "" })}
          submitLabel={`Approve ${count} change(s)`}
          onDone={() => {
            close();
            router.refresh();
          }}
        >
          <Field label="Reason" hint={REASON_HINT}>
            <Textarea name="reason" maxLength={REASON_MAX} rows={3} required />
          </Field>
        </ActionForm>
      )}
    </FormSheet>
  );
}
