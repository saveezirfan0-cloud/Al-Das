"use client";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ActionForm, Field, RunButton, selectClass } from "@/components/finance/forms";
import { CATEGORY_LABELS, DENIAL_CATEGORIES } from "@/lib/finance/denials";
import type { BlueprintSettings } from "@/lib/finance/blueprint-settings";
import { ageingBuckets } from "@/lib/finance/followup";
import type { FollowupSettings } from "@/lib/finance/followup-settings";
import type { FinanceSettings } from "@/lib/finance/settings-db";

import {
  deleteDenialCode,
  deletePayerPrice,
  importPayerPrices,
  saveBlueprintSettings,
  saveDenialCode,
  saveChangeReviewSettings,
  saveFollowupSettings,
  saveThresholds,
} from "./actions";

const Check = ({ name, label, checked }: { name: string; label: string; checked: boolean }) => (
  <label className="flex items-center gap-2 text-sm">
    <input type="checkbox" name={name} defaultChecked={checked} /> {label}
  </label>
);
const pct = (v: number) => Math.round(v * 10000) / 100;

export function ThresholdsForm({ s }: { s: FinanceSettings }) {
  return (
    <ActionForm action={saveThresholds} submitLabel="Save settings">
      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-1 text-sm font-semibold">Pre-authorisations</legend>
        <Field label="Remind this many days before expiry">
          <Input
            name="preauth_expiry_lead_days"
            inputMode="numeric"
            defaultValue={s.preauthExpiryLeadDays}
          />
        </Field>
        <div className="flex items-end">
          <Check
            name="preauth_task_enabled"
            label="Create a task too"
            checked={s.preauthTaskEnabled}
          />
        </div>
      </fieldset>
      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-1 text-sm font-semibold">Ready to bill</legend>
        <Field
          label="Check insurance invoices dated from"
          hint="Blank = off. Nothing earlier is ever flagged."
        >
          <Input name="ready_start_date" type="date" defaultValue={s.readyStartDate ?? ""} />
        </Field>
        <Field label="Leave the last N days alone">
          <Input name="ready_grace_days" inputMode="numeric" defaultValue={s.readyGraceDays} />
        </Field>
      </fieldset>
      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-1 text-sm font-semibold">Denials</legend>
        <Field
          label="Open denial cases from"
          hint="Blank = off. Earlier denials never become cases."
        >
          <Input
            name="denial_cases_start_date"
            type="date"
            defaultValue={s.denialCasesStartDate ?? ""}
          />
        </Field>
        <Field label="Default days to resubmit">
          <Input
            name="denial_default_resubmit_days"
            inputMode="numeric"
            defaultValue={s.denialDefaultResubmitDays}
          />
        </Field>
        <Field label="Warn this many days before the deadline">
          <Input name="denial_warn_days" inputMode="numeric" defaultValue={s.denialWarnDays} />
        </Field>
        <div className="flex items-end">
          <Check
            name="denial_task_enabled"
            label="Create a task too"
            checked={s.denialTaskEnabled}
          />
        </div>
      </fieldset>
      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-1 text-sm font-semibold">Short payments</legend>
        <Field
          label="Tolerance, amount (AED)"
          hint="A payment is short only when it misses by more than BOTH tolerances."
        >
          <Input
            name="short_pay_tolerance_amount"
            inputMode="decimal"
            defaultValue={s.shortPayToleranceAmount}
          />
        </Field>
        <Field label="Tolerance, share of the amount (%)">
          <Input
            name="short_pay_tolerance_pct_percent"
            inputMode="decimal"
            defaultValue={pct(s.shortPayTolerancePct)}
          />
        </Field>
      </fieldset>
      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-1 text-sm font-semibold">Scorecards</legend>
        <Field label="Fewest claims to judge a row">
          <Input
            name="scorecard_min_claims"
            inputMode="numeric"
            defaultValue={s.scorecardMinClaims}
          />
        </Field>
        <Field label="Denial rate: amber from (%)">
          <Input
            name="scorecard_denial_rate_warn_percent"
            inputMode="decimal"
            defaultValue={pct(s.scorecardDenialRateWarn)}
          />
        </Field>
        <Field label="Denial rate: red from (%)">
          <Input
            name="scorecard_denial_rate_alert_percent"
            inputMode="decimal"
            defaultValue={pct(s.scorecardDenialRateAlert)}
          />
        </Field>
        <Field label="Days to pay: amber from">
          <Input
            name="scorecard_days_to_pay_warn"
            inputMode="numeric"
            defaultValue={s.scorecardDaysToPayWarn}
          />
        </Field>
        <Field label="Days to pay: red from">
          <Input
            name="scorecard_days_to_pay_alert"
            inputMode="numeric"
            defaultValue={s.scorecardDaysToPayAlert}
          />
        </Field>
      </fieldset>
      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-1 text-sm font-semibold">Collections forecast</legend>
        <Field label="Weeks ahead">
          <Input
            name="forecast_horizon_weeks"
            inputMode="numeric"
            defaultValue={s.forecastHorizonWeeks}
          />
        </Field>
        <Field label="Payer with little history: days to pay">
          <Input
            name="forecast_default_lag_days"
            inputMode="numeric"
            defaultValue={s.forecastDefaultLagDays}
          />
        </Field>
        <Field label="Payer with little history: collected (%)">
          <Input
            name="forecast_default_collection_rate_percent"
            inputMode="decimal"
            defaultValue={pct(s.forecastDefaultCollectionRate)}
          />
        </Field>
        <Field label="Paid claims needed to trust a payer">
          <Input
            name="forecast_min_history"
            inputMode="numeric"
            defaultValue={s.forecastMinHistory}
          />
        </Field>
        <Field label="Weeks for the last 10% of payments">
          <Input
            name="forecast_tail_weeks"
            inputMode="numeric"
            defaultValue={s.forecastTailWeeks}
          />
        </Field>
      </fieldset>
      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-1 text-sm font-semibold">Cash-up</legend>
        <Field label="A difference up to this needs no reason (AED)">
          <Input
            name="cashup_variance_tolerance"
            inputMode="decimal"
            defaultValue={s.cashupVarianceTolerance}
          />
        </Field>
      </fieldset>
    </ActionForm>
  );
}

export type CodeRow = {
  code: string;
  is_family: boolean;
  description: string;
  category: string;
  default_owner_role: string;
  resubmit_days: number | null;
  appealable: boolean;
  active: boolean;
  is_placeholder: boolean;
};

export function CodeForm({ row }: { row?: CodeRow }) {
  return (
    <ActionForm
      action={saveDenialCode}
      submitLabel={row ? "Save" : "Add code"}
      variant="secondary"
      className="rounded-md border p-3"
    >
      <div className="grid gap-2 sm:grid-cols-6">
        <Field label="Code">
          <Input
            name="code"
            defaultValue={row?.code ?? ""}
            readOnly={!!row}
            required
            maxLength={40}
          />
        </Field>
        <Field label="Description" className="sm:col-span-2">
          <Input
            name="description"
            defaultValue={row?.description ?? ""}
            required
            maxLength={200}
          />
        </Field>
        <Field label="Category">
          <select name="category" className={selectClass} defaultValue={row?.category ?? "other"}>
            {DENIAL_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Owner">
          <select
            name="default_owner_role"
            className={selectClass}
            defaultValue={row?.default_owner_role ?? "insurance"}
          >
            <option value="insurance">Insurance</option>
            <option value="billing">Billing</option>
            <option value="finance">Finance</option>
            <option value="admin">Admin</option>
          </select>
        </Field>
        <Field label="Days to resubmit">
          <Input
            name="resubmit_days"
            inputMode="numeric"
            defaultValue={row?.resubmit_days ?? ""}
            placeholder="default"
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Check
          name="is_family"
          label="A family: also covers codes that start with these letters"
          checked={row?.is_family ?? false}
        />
        <Check name="appealable" label="Normally appealable" checked={row?.appealable ?? true} />
        <Check name="active" label="Active" checked={row?.active ?? true} />
        {row?.is_placeholder && (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            Starter placeholder: replace with the payer&apos;s real list
          </span>
        )}
      </div>
    </ActionForm>
  );
}

export const RemoveCode = ({ code }: { code: string }) => (
  <RunButton
    variant="ghost"
    confirm={`Remove the code ${code}?`}
    action={() => deleteDenialCode(code)}
  >
    Remove
  </RunButton>
);
export const RemovePrice = ({ id }: { id: string }) => (
  <RunButton variant="ghost" confirm="Remove this price?" action={() => deletePayerPrice(id)}>
    Remove
  </RunButton>
);

export function PriceImport() {
  return (
    <ActionForm action={importPayerPrices} submitLabel="Save prices" variant="secondary">
      <Field label="Payer ID">
        <Input name="payer_id" required maxLength={60} />
      </Field>
      <Field
        label="Prices"
        hint="One service per line: CPT code, agreed price, and optionally the date it starts (dd-mm-yyyy). Pasting again for the same code and date replaces the price."
      >
        <Textarea
          name="text"
          rows={6}
          required
          placeholder={"99213, 180\n99214, 250, 01-01-2026"}
        />
      </Field>
    </ActionForm>
  );
}

export function BlueprintSettingsForm({ s }: { s: BlueprintSettings }) {
  return (
    <ActionForm action={saveBlueprintSettings} submitLabel="Save settings">
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-1 text-sm font-semibold">Which doctor counts</legend>
        <Field
          label="Doctor basis for revenue and doctor reports"
          hint="Management and the Medical Director decide this. Until then the invoice's doctor is used and reports say so."
        >
          <select name="doctor_basis" defaultValue={s.doctorBasis ?? ""} className={selectClass}>
            <option value="">Not decided</option>
            <option value="ordering">Ordering doctor</option>
            <option value="performing">Performing doctor</option>
          </select>
        </Field>
      </fieldset>
      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-semibold">Accepted claims</legend>
        <Field
          label="Claim statuses that show a claim was accepted"
          hint="One per line or comma separated, as they appear in Diligence. A remitted amount always counts as evidence; a claim with neither is never assumed accepted."
        >
          <Textarea
            name="accepted_claim_statuses"
            rows={3}
            defaultValue={s.acceptedClaimStatuses.join("\n")}
          />
        </Field>
      </fieldset>
      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-1 text-sm font-semibold">Visit and billing checks (E11, E12)</legend>
        <Field
          label="Compare visits and invoices dated from"
          hint="Blank = off. Nothing earlier is ever flagged. These are review signals, not proof."
        >
          <Input name="evidence_start_date" type="date" defaultValue={s.evidenceStartDate ?? ""} />
        </Field>
        <Field label="Match within this many days">
          <Input
            name="evidence_grace_days"
            inputMode="numeric"
            defaultValue={s.evidenceGraceDays}
          />
        </Field>
      </fieldset>
      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-1 text-sm font-semibold">Escalation</legend>
        <Field label="Escalate after this many days overdue">
          <Input name="escalation_days" inputMode="numeric" defaultValue={s.escalationDays} />
        </Field>
        <Field label="Escalate to">
          <select name="escalation_role" defaultValue={s.escalationRole} className={selectClass}>
            <option value="finance">Finance</option>
            <option value="insurance">Insurance</option>
            <option value="billing">Billing</option>
            <option value="admin">Admin</option>
          </select>
        </Field>
      </fieldset>
    </ActionForm>
  );
}

export function FollowupSettingsForm({
  s,
  roles,
}: {
  s: FollowupSettings;
  roles: readonly string[];
}) {
  const roleOptions = roles.includes(s.taskRole) ? roles : [s.taskRole, ...roles];
  return (
    <ActionForm action={saveFollowupSettings} submitLabel="Save settings">
      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-1 text-sm font-semibold">Ageing</legend>
        <Field
          label="Ageing buckets (days)"
          hint={`Gives ${ageingBuckets(s.bucketDays)
            .map((b) => b.label)
            .join(" / ")}. Used by Insurance follow-up and Receivables by age.`}
          className="sm:col-span-2"
        >
          <Input name="ageing_bucket_days" defaultValue={s.bucketDays.join(", ")} />
        </Field>
      </fieldset>
      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-1 text-sm font-semibold">Follow-up of unpaid claims</legend>
        <Field label="Follow-up stages (days unpaid)" hint="For example 60, 90, 120.">
          <Input name="followup_stage_days" defaultValue={s.stageDays.join(", ")} />
        </Field>
        <Field
          label="Create follow-up tasks from"
          hint="Blank = off. A stage reached before this date never creates a task."
        >
          <Input name="followup_start_date" type="date" defaultValue={s.startDate ?? ""} />
        </Field>
        <Field label="Give the tasks to members of">
          <select name="followup_task_role" className={selectClass} defaultValue={s.taskRole}>
            {roleOptions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Task due after (days)">
          <Input name="followup_task_due_days" inputMode="numeric" defaultValue={s.taskDueDays} />
        </Field>
        <div className="flex items-end">
          <Check name="followup_task_enabled" label="Create tasks" checked={s.taskEnabled} />
        </div>
      </fieldset>
    </ActionForm>
  );
}

export function ChangeReviewSettingsForm({
  s,
}: {
  s: { startDate: string | null; minAmount: number; bulkMax: number };
}) {
  return (
    <ActionForm action={saveChangeReviewSettings} submitLabel="Save settings">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          label="Count unapproved invoice changes from"
          hint="Blank = the register works but the measure is not counted. Changes before this date are never counted."
        >
          <Input name="change_review_start_date" type="date" defaultValue={s.startDate ?? ""} />
        </Field>
        <Field
          label="Approval needed from (AED)"
          hint="0 = every change needs an approval. A change below this amount needs none."
        >
          <Input name="change_review_min_amount" inputMode="decimal" defaultValue={s.minAmount} />
        </Field>
        <Field
          label="Bulk approval up to (AED)"
          hint="Unreviewed changes up to this amount can be approved together with one reason. 0 = off."
        >
          <Input name="change_bulk_approve_max" inputMode="decimal" defaultValue={s.bulkMax} />
        </Field>
      </div>
    </ActionForm>
  );
}
