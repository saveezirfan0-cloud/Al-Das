"use client";

import * as React from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ActionForm, Field, FormSheet, selectClass } from "@/components/finance/forms";
import { RecordHistorySection } from "@/components/history/record-history";

import {
  createEligibilityCheck,
  listCardDocuments,
  updateEligibilityCheck,
  type CardChoice,
} from "./actions";

export type CheckRow = {
  id: string;
  patient_pin: string | null;
  payer_id: string;
  status: "pending" | "verified" | "failed" | "expired";
  method: string;
  valid_from: string | null;
  valid_to: string | null;
  checked_on: string | null;
  has_card: boolean;
  document_id: string | null;
  result_note: string | null;
};

const VARIANT = {
  pending: "secondary",
  verified: "success",
  failed: "destructive",
  expired: "warning",
} as const;
export const CheckStatusBadge = ({ status }: { status: CheckRow["status"] }) => (
  <Badge variant={VARIANT[status]}>{status}</Badge>
);

function CardPicker({
  pin,
  enabled,
  current,
}: {
  pin: () => string;
  enabled: boolean;
  current?: string | null;
}) {
  const [cards, setCards] = React.useState<CardChoice[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  if (!enabled)
    return (
      <p className="text-muted-foreground text-xs">
        You do not have access to patient documents, so a card cannot be attached here. The check
        will be flagged “no card on file”.
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={async () => {
            const p = pin().trim();
            if (!p) return toast.error("Enter the PIN first.");
            setBusy(true);
            const res = await listCardDocuments(p);
            setBusy(false);
            if (res.ok) {
              setCards(res.data ?? []);
              if ((res.data ?? []).length === 0)
                toast.message("No insurance card is filed for this patient.");
            } else toast.error(res.error);
          }}
        >
          Find this patient&apos;s cards
        </Button>
        <span className="text-muted-foreground text-xs">
          Opens only a list: ids and dates, never the picture.
        </span>
      </div>
      <select name="document_id" className={selectClass} defaultValue={current ?? ""}>
        <option value="">No card attached</option>
        {current && !cards?.some((c) => c.id === current) && (
          <option value={current}>Card already attached</option>
        )}
        {(cards ?? []).map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
            {c.scan === "unscanned" ? " (not scanned)" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

const StatusFields = ({ row }: { row?: CheckRow }) => (
  <>
    <Field label="Result">
      <select name="status" className={selectClass} defaultValue={row?.status ?? "verified"}>
        <option value="pending">Pending (not finished)</option>
        <option value="verified">Verified: cover is active</option>
        <option value="failed">Failed: not covered</option>
        <option value="expired">Expired</option>
      </select>
    </Field>
    <div className="grid grid-cols-2 gap-3">
      <Field label="Cover from">
        <Input name="valid_from" type="date" defaultValue={row?.valid_from ?? ""} />
      </Field>
      <Field label="Cover until" hint="Needed when verified.">
        <Input name="valid_to" type="date" defaultValue={row?.valid_to ?? ""} />
      </Field>
    </div>
    <div className="grid grid-cols-2 gap-3">
      <Field label="Checked on">
        <Input name="checked_on" type="date" defaultValue={row?.checked_on ?? ""} />
      </Field>
      <Field label="How">
        <select name="method" className={selectClass} defaultValue={row?.method ?? "portal"}>
          <option value="portal">Payer portal</option>
          <option value="phone">Phone</option>
          <option value="card_only">Card only</option>
          <option value="other">Other</option>
        </select>
      </Field>
    </div>
    <Field label="Note" hint="Short, no clinical detail.">
      <Input name="result_note" maxLength={200} defaultValue={row?.result_note ?? ""} />
    </Field>
  </>
);

export function NewCheckButton({
  canSeeCards,
  defaultPin,
}: {
  canSeeCards: boolean;
  defaultPin?: string;
}) {
  const pinRef = React.useRef<HTMLInputElement>(null);
  return (
    <FormSheet
      trigger={defaultPin ? "Add a check" : "New eligibility check"}
      variant={defaultPin ? "outline" : "default"}
      size={defaultPin ? "sm" : "default"}
      title="Eligibility check"
      description="Record that you checked the patient's cover, and file which insurance card you saw."
    >
      {(close) => (
        <ActionForm action={createEligibilityCheck} onDone={close}>
          <Field label="Patient PIN (Unite)">
            <Input
              ref={pinRef}
              name="pin"
              required
              maxLength={60}
              defaultValue={defaultPin ?? ""}
            />
          </Field>
          <Field label="Payer ID">
            <Input name="payer_id" required maxLength={60} />
          </Field>
          <Field label="Appointment number" hint="Optional.">
            <Input name="appointment_number" inputMode="numeric" />
          </Field>
          <StatusFields />
          <Field label="Insurance card">
            <CardPicker pin={() => pinRef.current?.value ?? ""} enabled={canSeeCards} />
          </Field>
        </ActionForm>
      )}
    </FormSheet>
  );
}

export function CheckDrawer({ row, canSeeCards }: { row: CheckRow; canSeeCards: boolean }) {
  return (
    <FormSheet
      trigger="Open"
      variant="outline"
      size="sm"
      title={`Eligibility check, PIN ${row.patient_pin ?? ""}`}
      description={`Payer ${row.payer_id}`}
    >
      {(close) => (
        <div className="flex flex-col gap-6">
          <ActionForm action={updateEligibilityCheck} onDone={close}>
            <input type="hidden" name="id" value={row.id} />
            <StatusFields row={row} />
            <Field label="Insurance card">
              <CardPicker
                pin={() => row.patient_pin ?? ""}
                enabled={canSeeCards}
                current={row.document_id}
              />
            </Field>
          </ActionForm>
          <RecordHistorySection table="fin_eligibility_checks" recordId={row.id} />
        </div>
      )}
    </FormSheet>
  );
}
