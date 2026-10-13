"use client";

import { ActionForm, RunButton, selectClass } from "@/components/finance/forms";
import { Input } from "@/components/ui/input";

import {
  decideMatch,
  markReviewed,
  reopenRun,
  runMatching,
  saveReason,
  signRun,
  undoMatch,
} from "../actions";

export function RunMatchingButton({ recId, count }: { recId: string; count: number }) {
  return (
    <RunButton variant="default" action={() => runMatching({ rec_id: recId })}>
      Save {count} automatic match(es)
    </RunButton>
  );
}

export function DecideButtons({
  recId,
  itemKey,
  lineId,
}: {
  recId: string;
  itemKey: string;
  lineId: string;
}) {
  const pair = { rec_id: recId, key: itemKey, line_id: lineId };
  return (
    <div className="flex gap-1">
      <RunButton variant="default" action={() => decideMatch({ ...pair, decision: "accept" })}>
        Accept
      </RunButton>
      <RunButton action={() => decideMatch({ ...pair, decision: "reject" })}>Reject</RunButton>
    </div>
  );
}

export function UndoMatchButton({
  recId,
  itemKey,
  lineId,
}: {
  recId: string;
  itemKey: string;
  lineId: string;
}) {
  return (
    <RunButton
      variant="ghost"
      confirm="Undo this match? Both sides go back to the open lists."
      action={() => undoMatch({ rec_id: recId, key: itemKey, line_id: lineId })}
    >
      Undo
    </RunButton>
  );
}

export function ReasonForm({
  recId,
  itemKey,
  reasons,
  code,
  note,
}: {
  recId: string;
  itemKey: string;
  reasons: Array<[string, string]>;
  code: string | null;
  note: string | null;
}) {
  return (
    <ActionForm action={saveReason} submitLabel="Save" variant="outline" className="min-w-64 gap-2">
      <input type="hidden" name="rec_id" value={recId} />
      <input type="hidden" name="item_key" value={itemKey} />
      <select
        name="code"
        defaultValue={code ?? ""}
        className={selectClass}
        aria-label="Reason"
        required
      >
        <option value="" disabled>
          Choose a reason
        </option>
        {reasons.map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
      </select>
      <Input
        name="note"
        defaultValue={note ?? ""}
        maxLength={200}
        placeholder="Note (no patient details)"
        aria-label="Note"
      />
    </ActionForm>
  );
}

export function ReviewButton({ recId }: { recId: string }) {
  return (
    <RunButton
      variant="default"
      confirm="Freeze these figures as reviewed? A second person then signs them."
      action={() => markReviewed({ rec_id: recId })}
    >
      Mark reviewed
    </RunButton>
  );
}

export function ReopenButton({ recId }: { recId: string }) {
  return <RunButton action={() => reopenRun({ rec_id: recId })}>Reopen</RunButton>;
}

export function SignButton({ recId, hash }: { recId: string; hash: string }) {
  return (
    <RunButton
      variant="default"
      confirm="Sign this bank reconciliation? Signed reconciliations cannot be changed."
      action={() => signRun({ rec_id: recId, hash })}
    >
      Sign off
    </RunButton>
  );
}
