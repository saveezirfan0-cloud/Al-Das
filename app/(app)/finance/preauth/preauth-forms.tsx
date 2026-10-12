"use client";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ActionForm, Field, FormSheet, RunButton, selectClass } from "@/components/finance/forms";
import { RecordHistorySection } from "@/components/history/record-history";
import { nextStatuses, PREAUTH_LABELS, type PreauthStatus } from "@/lib/finance/preauth";

import {
  changePreauthStatus,
  createPreauth,
  recordPreauthDecision,
  updatePreauth,
} from "./actions";

export type PreauthRow = {
  id: string;
  patient_pin: string | null;
  payer_id: string;
  auth_number: string | null;
  cpt_codes: string[];
  status: PreauthStatus;
  requested_on: string | null;
  decision_on: string | null;
  valid_from: string | null;
  expires_on: string | null;
  approved_amount: number | null;
  approved_units: number | null;
  reference_note: string | null;
  appointment_number: number | null;
  claim_number: string | null;
  hasAppointment: boolean;
  hasClaim: boolean;
};

export function NewPreauthButton() {
  return (
    <FormSheet
      trigger="New pre-authorisation"
      title="New pre-authorisation"
      description="Record a request you have sent, or save a draft. Use the Unite PIN, not the patient's name."
    >
      {(close) => (
        <ActionForm action={createPreauth} submitLabel="Save" onDone={close}>
          <Field label="Patient PIN (Unite)">
            <Input name="pin" required maxLength={60} />
          </Field>
          <Field label="Payer ID">
            <Input name="payer_id" required maxLength={60} />
          </Field>
          <Field label="Services (CPT codes)" hint="Separate with commas or spaces.">
            <Input name="cpt_codes" maxLength={400} />
          </Field>
          <Field label="Appointment number" hint="Optional. The number shown on the appointment.">
            <Input name="appointment_number" inputMode="numeric" />
          </Field>
          <Field
            label="Claim activity number"
            hint="Optional. Link it once the claim exists; it also links itself when the claim quotes the authorisation number."
          >
            <Input name="claim_number" maxLength={80} />
          </Field>
          <Field label="Requested on">
            <Input name="requested_on" type="date" />
          </Field>
          <Field label="Reference note" hint="Short, no clinical detail.">
            <Input name="reference_note" maxLength={200} />
          </Field>
          <Field label="Save as">
            <select name="status" className={selectClass} defaultValue="requested">
              <option value="requested">Requested (sent to the payer)</option>
              <option value="draft">Draft (not sent yet)</option>
            </select>
          </Field>
        </ActionForm>
      )}
    </FormSheet>
  );
}

const STATUS_VARIANT: Record<
  PreauthStatus,
  "default" | "secondary" | "success" | "warning" | "destructive" | "outline"
> = {
  draft: "outline",
  requested: "secondary",
  approved: "success",
  partially_approved: "success",
  denied: "destructive",
  expired: "warning",
  cancelled: "outline",
  used: "default",
};

export function PreauthStatusBadge({ status }: { status: PreauthStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{PREAUTH_LABELS[status]}</Badge>;
}

export function PreauthDrawer({ row }: { row: PreauthRow }) {
  const moves = nextStatuses(row.status);
  const canDecide = row.status === "requested";
  return (
    <FormSheet
      trigger="Open"
      variant="outline"
      size="sm"
      title={`Pre-authorisation ${row.auth_number ?? "(no number yet)"}`}
      description={`PIN ${row.patient_pin ?? "unknown"}, payer ${row.payer_id}`}
    >
      {(close) => (
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-2 text-sm">
            <PreauthStatusBadge status={row.status} />
            {row.expires_on && (
              <span className="text-muted-foreground">expires {row.expires_on}</span>
            )}
          </div>

          {canDecide && (
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">Record the payer&apos;s answer</h3>
              <ActionForm action={recordPreauthDecision} submitLabel="Record answer" onDone={close}>
                <input type="hidden" name="id" value={row.id} />
                <Field label="Answer">
                  <select name="decision" className={selectClass} defaultValue="approved">
                    <option value="approved">Approved</option>
                    <option value="partially_approved">Partly approved</option>
                    <option value="denied">Denied</option>
                  </select>
                </Field>
                <Field label="Payer's authorisation number" hint="Needed for an approval.">
                  <Input name="auth_number" maxLength={80} defaultValue={row.auth_number ?? ""} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Valid from">
                    <Input name="valid_from" type="date" defaultValue={row.valid_from ?? ""} />
                  </Field>
                  <Field label="Expires on" hint="Needed for an approval.">
                    <Input name="expires_on" type="date" defaultValue={row.expires_on ?? ""} />
                  </Field>
                  <Field label="Approved amount (AED)">
                    <Input
                      name="approved_amount"
                      inputMode="decimal"
                      defaultValue={row.approved_amount ?? ""}
                    />
                  </Field>
                  <Field label="Approved visits or units">
                    <Input
                      name="approved_units"
                      inputMode="numeric"
                      defaultValue={row.approved_units ?? ""}
                    />
                  </Field>
                </div>
                <Field label="Answer received on">
                  <Input name="decision_on" type="date" defaultValue={row.decision_on ?? ""} />
                </Field>
              </ActionForm>
            </section>
          )}

          {moves.length > 0 && (
            <section className="flex flex-wrap gap-2">
              {moves.includes("used") && (
                <RunButton
                  action={() => changePreauthStatus({ id: row.id, to: "used" })}
                  onDone={close}
                >
                  Mark as used
                </RunButton>
              )}
              {moves.includes("requested") && (
                <RunButton
                  action={() => changePreauthStatus({ id: row.id, to: "requested" })}
                  onDone={close}
                >
                  Request again
                </RunButton>
              )}
              {moves.includes("cancelled") && (
                <RunButton
                  variant="outline"
                  confirm="Cancel this pre-authorisation?"
                  action={() => changePreauthStatus({ id: row.id, to: "cancelled" })}
                  onDone={close}
                >
                  Cancel it
                </RunButton>
              )}
            </section>
          )}

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Details</h3>
            <ActionForm action={updatePreauth} submitLabel="Save details" variant="secondary">
              <input type="hidden" name="id" value={row.id} />
              <Field label="Payer ID">
                <Input name="payer_id" defaultValue={row.payer_id} required maxLength={60} />
              </Field>
              <Field label="Services (CPT codes)">
                <Input name="cpt_codes" defaultValue={row.cpt_codes.join(", ")} maxLength={400} />
              </Field>
              <Field label="Appointment number">
                <Input
                  name="appointment_number"
                  inputMode="numeric"
                  defaultValue={row.appointment_number ?? ""}
                />
              </Field>
              <Field label="Claim activity number">
                <Input name="claim_number" defaultValue={row.claim_number ?? ""} maxLength={80} />
              </Field>
              <Field label="Reference note">
                <Textarea
                  name="reference_note"
                  defaultValue={row.reference_note ?? ""}
                  maxLength={200}
                  rows={2}
                />
              </Field>
            </ActionForm>
          </section>

          <RecordHistorySection table="fin_pre_authorisations" recordId={row.id} />
        </div>
      )}
    </FormSheet>
  );
}
