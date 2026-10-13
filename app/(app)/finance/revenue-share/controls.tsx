"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { ActionForm, Field, FormSheet, RunButton, selectClass } from "@/components/finance/forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  CHARGE_KIND_LABELS,
  CHARGE_KINDS,
  CHARGES_TEMPLATE,
  MAX_CATEGORY_RATES,
  type RevshareRule,
} from "@/lib/finance/revshare";

import {
  addDoctorCharge,
  approveRevshareRun,
  buildRevshareRun,
  deleteDoctorCharge,
  postRevshareRun,
  recordRevsharePayment,
  revshareSchemeStep,
  saveRevshareScheme,
  uploadDoctorCharges,
  verifyRevshareRun,
  withdrawRevshareRun,
} from "./actions";

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export function BuildRunButton({ month, rebuild }: { month: string; rebuild: boolean }) {
  return (
    <RunButton
      variant={rebuild ? "outline" : "default"}
      size="default"
      confirm={
        rebuild ? "Rebuild the draft from today's data? The current draft is replaced." : undefined
      }
      action={() => buildRevshareRun({ month })}
    >
      {rebuild ? "Rebuild the draft" : "Build the draft"}
    </RunButton>
  );
}

export function RunStepButton({
  step,
  id,
  month,
  hash,
}: {
  step: "verify" | "withdraw" | "approve";
  id: string;
  month: string;
  hash: string;
}) {
  const action =
    step === "verify"
      ? verifyRevshareRun
      : step === "approve"
        ? approveRevshareRun
        : withdrawRevshareRun;
  const label =
    step === "verify"
      ? "Verify for Finance"
      : step === "approve"
        ? "Approve as CEO"
        : "Return to draft";
  const confirm =
    step === "verify"
      ? "Verify this run? You confirm every doctor's calculation shown here. The run and the month's charges are then frozen."
      : step === "approve"
        ? "Approve this run? The payouts become a liability to be posted and paid."
        : "Return this run to draft so it can be rebuilt?";
  return (
    <RunButton
      variant={step === "withdraw" ? "outline" : "default"}
      size="default"
      confirm={confirm}
      action={() => action({ id, month, hash })}
    >
      {label}
    </RunButton>
  );
}

export function PostForm({ id, month }: { id: string; month: string }) {
  return (
    <ActionForm
      submitLabel="Save the accounting reference"
      action={(v) => postRevshareRun({ id, month, ref: v.ref ?? "" })}
    >
      <Field
        label="Accounting reference"
        hint="The journal or voucher number in Tally (or the export reference)."
      >
        <Input name="ref" maxLength={80} required />
      </Field>
    </ActionForm>
  );
}

export function PaymentSheet({
  lineId,
  month,
  doctor,
  paidOn,
  paymentRef,
}: {
  lineId: string;
  month: string;
  doctor: string;
  paidOn: string | null;
  paymentRef: string | null;
}) {
  return (
    <FormSheet
      trigger={paidOn ? "Correct" : "Record payment"}
      title={`Payment to ${doctor}`}
      description="The date the doctor was paid and the bank or payment reference."
      variant="outline"
      size="sm"
    >
      {(close) => (
        <ActionForm
          submitLabel="Save payment"
          onDone={close}
          action={(v) => recordRevsharePayment({ ...v, line_id: lineId, month })}
        >
          <Field label="Paid on">
            <Input name="paid_on" type="date" defaultValue={paidOn ?? ""} required />
          </Field>
          <Field label="Payment reference" hint="Bank transfer or cheque reference.">
            <Input name="ref" maxLength={80} defaultValue={paymentRef ?? ""} required />
          </Field>
        </ActionForm>
      )}
    </FormSheet>
  );
}

// ---------------------------------------------------------------------------
// Schemes
// ---------------------------------------------------------------------------

const asPct = (r: number | undefined) =>
  r === undefined ? "" : String(Math.round(r * 1_000_000) / 10_000);

export function SchemeSheet({
  trigger,
  scheme,
  categories,
  doctor,
}: {
  trigger: string;
  scheme?: {
    id: string;
    doctor: string;
    effectiveFrom: string;
    rule: RevshareRule;
    note: string | null;
  };
  categories: string[];
  doctor?: string;
}) {
  const rule = scheme?.rule;
  const existing = Object.entries(rule?.category_rates ?? {});
  const [rows, setRows] = React.useState(Math.max(existing.length, 1));
  return (
    <FormSheet
      trigger={trigger}
      title={scheme ? `Edit draft: ${scheme.doctor}` : "New scheme version"}
      description="The approved rule of a doctor's contract. Saving makes a draft; Finance verifies it and the CEO approves it before any run uses it."
      variant={scheme ? "outline" : "default"}
      size="sm"
    >
      {(close) => (
        <ActionForm submitLabel="Save draft" onDone={close} action={(v) => saveRevshareScheme(v)}>
          <input type="hidden" name="scheme_id" value={scheme?.id ?? ""} />
          <Field label="Doctor (DHA id)" hint="As on Unite invoices, for example SYN-0001.">
            <Input
              name="doctor_dha_id"
              defaultValue={scheme?.doctor ?? doctor ?? ""}
              readOnly={!!scheme}
              maxLength={40}
              required
            />
          </Field>
          <Field label="Applies from (month)" hint="The first month this version is used for.">
            <Input
              name="effective_month"
              type="month"
              defaultValue={scheme?.effectiveFrom.slice(0, 7) ?? ""}
              required
            />
          </Field>
          <Field
            label="Share of net revenue (%)"
            hint="Applied to every service category without its own rate."
          >
            <Input
              name="default_pct"
              inputMode="decimal"
              defaultValue={asPct(rule?.default_rate)}
              required
            />
          </Field>
          <fieldset className="flex flex-col gap-2 text-sm">
            <legend className="font-medium">Category rates (optional)</legend>
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="flex gap-2">
                <select
                  name={`cat_name_${i}`}
                  aria-label={`Category ${i + 1}`}
                  className={selectClass}
                  defaultValue={existing[i]?.[0] ?? ""}
                >
                  <option value="">(none)</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <Input
                  name={`cat_pct_${i}`}
                  aria-label={`Rate for category ${i + 1} (%)`}
                  inputMode="decimal"
                  placeholder="%"
                  className="w-24"
                  defaultValue={asPct(existing[i]?.[1])}
                />
              </div>
            ))}
            {rows < MAX_CATEGORY_RATES && (
              <div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setRows((n) => n + 1)}
                >
                  Add a category rate
                </Button>
              </div>
            )}
          </fieldset>
          <fieldset className="flex flex-col gap-2 text-sm">
            <legend className="font-medium">Charges deducted from the share (%)</legend>
            {CHARGE_KINDS.map((k) => (
              <Field
                key={k}
                label={CHARGE_KIND_LABELS[k]}
                className="flex-row items-center justify-between"
              >
                <Input
                  name={`ded_${k}_pct`}
                  inputMode="decimal"
                  className="w-24"
                  defaultValue={
                    rule ? asPct(rule.deductions[k]) : k === "lab" || k === "referral" ? "100" : ""
                  }
                />
              </Field>
            ))}
          </fieldset>
          <Field
            label="Threshold (AED a month, optional)"
            hint="Only revenue above this earns a share, spread pro rata over the categories."
          >
            <Input name="threshold" inputMode="decimal" defaultValue={rule?.threshold ?? ""} />
          </Field>
          <Field
            label="Minimum guarantee (AED a month, optional)"
            hint="The payout is never below this."
          >
            <Input
              name="guarantee"
              inputMode="decimal"
              defaultValue={rule?.minimum_guarantee ?? ""}
            />
          </Field>
          <Field label="Note (optional)" hint="Contract reference; no patient names.">
            <Input name="note" maxLength={300} defaultValue={scheme?.note ?? ""} />
          </Field>
        </ActionForm>
      )}
    </FormSheet>
  );
}

export function SchemeStepButton({
  id,
  hash,
  step,
}: {
  id: string;
  hash: string;
  step: "verify" | "approve" | "retire" | "delete";
}) {
  const labels = {
    verify: "Verify",
    approve: "Approve",
    retire: "Retire",
    delete: "Delete draft",
  } as const;
  const confirms = {
    verify: "Verify this rule? You confirm it matches the doctor's contract.",
    approve: "Approve this rule? Runs from its start month will use it.",
    retire: "Retire this version? Months from its start month will have no scheme for this doctor.",
    delete: "Delete this draft?",
  } as const;
  return (
    <RunButton
      variant={step === "verify" || step === "approve" ? "default" : "outline"}
      confirm={confirms[step]}
      action={() => revshareSchemeStep({ id, hash, step })}
    >
      {labels[step]}
    </RunButton>
  );
}

// ---------------------------------------------------------------------------
// Charges
// ---------------------------------------------------------------------------

export function ChargeSheet({ month }: { month: string }) {
  return (
    <FormSheet
      trigger="Add a charge"
      title="Add a doctor charge"
      description="Charged to the doctor's account for the month."
    >
      {(close) => (
        <ActionForm submitLabel="Save charge" onDone={close} action={(v) => addDoctorCharge(v)}>
          <Field label="Month">
            <Input name="month" type="month" defaultValue={month} required />
          </Field>
          <Field label="Doctor (DHA id)">
            <Input name="doctor_dha_id" maxLength={40} required />
          </Field>
          <Field label="Kind">
            <select name="kind" className={selectClass} defaultValue="lab">
              {CHARGE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {CHARGE_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Amount (AED)">
            <Input name="amount" inputMode="decimal" required />
          </Field>
          <Field label="Reference (optional)" hint="Lab or referral invoice number.">
            <Input name="reference" maxLength={80} />
          </Field>
          <Field label="Note (optional)" hint="No patient names.">
            <Input name="note" maxLength={300} />
          </Field>
        </ActionForm>
      )}
    </FormSheet>
  );
}

export function DeleteChargeButton({ id }: { id: string }) {
  return (
    <RunButton confirm="Delete this charge?" action={() => deleteDoctorCharge({ id })}>
      Delete
    </RunButton>
  );
}

/** Paste a CSV or choose a file; nothing is saved until every row is valid. */
export function ChargesUpload() {
  const [text, setText] = React.useState("");
  const [pending, start] = React.useTransition();
  const download = () => {
    const blob = new Blob([CHARGES_TEMPLATE], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "doctor-charges-template.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const res = await uploadDoctorCharges(text);
          if (res.ok) {
            toast.success(res.message ?? "Saved");
            setText("");
          } else toast.error(res.error, { duration: 12000 });
        });
      }}
    >
      <Textarea
        rows={5}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={CHARGES_TEMPLATE.trim()}
        className="font-mono text-xs"
        aria-label="CSV text"
      />
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label="Choose a CSV file"
          className="text-xs"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setText(await f.text());
          }}
        />
        <Button type="submit" disabled={pending || text.trim() === ""}>
          {pending && <Loader2 className="animate-spin" />} Save file
        </Button>
        <Button type="button" variant="outline" onClick={download}>
          Download template
        </Button>
      </div>
    </form>
  );
}
