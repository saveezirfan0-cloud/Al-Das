"use client";

import { ActionForm, Field, FormSheet, RunButton, selectClass } from "@/components/finance/forms";
import { Input } from "@/components/ui/input";
import type { ApprovalMode, ApprovalTier } from "@/lib/finance/vouchers";

import {
  deleteLedger,
  saveApprovalSettings,
  saveLedger,
  saveTallySettings,
  saveTier,
} from "./actions";

const Check = ({ name, label, checked }: { name: string; label: string; checked: boolean }) => (
  <label className="flex min-h-11 items-center gap-2 text-sm">
    <input type="checkbox" name={name} defaultChecked={checked} /> {label}
  </label>
);

export function TierButton({ tier }: { tier?: ApprovalTier }) {
  return (
    <FormSheet
      trigger={tier ? "Edit" : "Add rule"}
      title={tier ? `Edit ${tier.code}` : "Add an approval rule"}
      description="An amount band (from and up to, inclusive) or a special category at any amount. The Finance Manager always verifies."
      variant={tier ? "ghost" : "outline"}
      size="sm"
    >
      {(close) => (
        <ActionForm action={saveTier} submitLabel="Save rule" onDone={close}>
          <Field label="Code" hint="For example T1, SP_PAYROLL.">
            <Input
              name="code"
              defaultValue={tier?.code ?? ""}
              readOnly={!!tier}
              maxLength={12}
              required
            />
          </Field>
          <Field label="Name">
            <Input name="label" defaultValue={tier?.label ?? ""} maxLength={60} required />
          </Field>
          <Field label="Applies to">
            <select
              name="special_category"
              className={selectClass}
              defaultValue={tier?.specialCategory ?? ""}
            >
              <option value="">An amount band</option>
              <option value="payroll">Payroll (any amount)</option>
              <option value="intercompany">Intercompany transfers (any amount)</option>
              <option value="related_party">Related-party transactions (any amount)</option>
            </select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="From (AED)" hint="Blank for a special category.">
              <Input
                name="min_amount"
                inputMode="decimal"
                defaultValue={tier?.minAmount?.toFixed(2) ?? ""}
              />
            </Field>
            <Field label="Up to (AED)" hint="Blank = no upper limit.">
              <Input
                name="max_amount"
                inputMode="decimal"
                defaultValue={tier?.maxAmount?.toFixed(2) ?? ""}
              />
            </Field>
          </div>
          <Check
            name="needs_dept_head"
            label="Needs a department head"
            checked={tier?.needsDeptHead ?? false}
          />
          <Check name="needs_ceo" label="Needs the CEO" checked={tier?.needsCeo ?? false} />
          <Check
            name="bulk_allowed"
            label="Routine: may be verified in bulk (only without department head or CEO)"
            checked={tier?.bulkAllowed ?? false}
          />
          <Check name="active" label="Active" checked={tier?.active ?? true} />
          <Field label="Description">
            <Input name="description" defaultValue={tier?.description ?? ""} maxLength={300} />
          </Field>
          <Field label="Order">
            <Input name="sort_order" inputMode="numeric" defaultValue={tier?.sortOrder ?? 100} />
          </Field>
        </ActionForm>
      )}
    </FormSheet>
  );
}

export function ApprovalSettingsForm({
  mode,
  tallyApprovalMax,
  duplicateWindowDays,
  mismatchTolerance,
  largeAmount,
}: {
  mode: ApprovalMode;
  tallyApprovalMax: number;
  duplicateWindowDays: number;
  mismatchTolerance: number;
  largeAmount: number;
}) {
  return (
    <ActionForm action={saveApprovalSettings} submitLabel="Save">
      <Field
        label="Where vouchers are approved (OQ-90)"
        hint="Pulse: maker, Finance Manager, department head and CEO approve here and vouchers reach Tally already authorised. Tally: Pulse keeps the voucher and its documents, skips its own approvals and exports the voucher for Tally's Transaction Authorisation. Split: routine vouchers up to the limit below are approved in Tally, larger ones and payroll, intercompany and related-party vouchers follow the rules above."
      >
        <select name="approval_mode" className={selectClass} defaultValue={mode}>
          <option value="pulse">Approve in Pulse (recommended)</option>
          <option value="tally">Approve in Tally</option>
          <option value="split">Split by amount: Tally up to the limit, Pulse above it</option>
        </select>
      </Field>
      <Field
        label="Tally approval limit (AED, split mode)"
        hint="Routine vouchers at or below this amount are approved in Tally. Finance's answer of 22 Oct 2026: 5,000; above it the CEO approves, so the rule for that band should include the CEO."
      >
        <Input
          name="tally_approval_max"
          inputMode="decimal"
          defaultValue={tallyApprovalMax.toFixed(2)}
        />
      </Field>
      <Field label="To change the mode, or the limit in split mode, type the mode (PULSE, TALLY or SPLIT)">
        <Input name="confirm" autoComplete="off" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          label="Duplicate window (days)"
          hint="Same payee and amount within this many days is flagged."
        >
          <Input
            name="voucher_duplicate_window_days"
            inputMode="numeric"
            defaultValue={duplicateWindowDays}
          />
        </Field>
        <Field label="Invoice mismatch tolerance (AED)" hint="Voucher amount vs its invoices.">
          <Input
            name="voucher_mismatch_tolerance"
            inputMode="decimal"
            defaultValue={mismatchTolerance.toFixed(2)}
          />
        </Field>
        <Field label="Large amount without invoice (AED)">
          <Input
            name="voucher_large_amount"
            inputMode="decimal"
            defaultValue={largeAmount.toFixed(2)}
          />
        </Field>
      </div>
    </ActionForm>
  );
}

export function LedgerForm({ kinds }: { kinds: Array<{ value: string; label: string }> }) {
  return (
    <ActionForm
      action={saveLedger}
      submitLabel="Save mapping"
      className="sm:flex-row sm:items-end sm:flex-wrap"
    >
      <Field label="What">
        <select name="kind" className={selectClass} defaultValue="category">
          {kinds.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="Pulse value"
        hint="Category name, supplier id, pay-from key, branch code; * for VAT input."
      >
        <Input name="key" maxLength={80} required />
      </Field>
      <Field label="Tally ledger (exact name)">
        <Input name="ledger_name" maxLength={120} required />
      </Field>
    </ActionForm>
  );
}

export function DeleteLedgerButton({ kind, keyValue }: { kind: string; keyValue: string }) {
  return (
    <RunButton
      variant="ghost"
      action={() => deleteLedger({ kind, key: keyValue })}
      confirm="Delete this mapping? Exports refuse until it is mapped again."
    >
      Delete
    </RunButton>
  );
}

export function TallySettingsForm({
  company,
  costCategory,
}: {
  company: string | null;
  costCategory: string;
}) {
  return (
    <ActionForm action={saveTallySettings} submitLabel="Save">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Tally company name"
          hint="Exactly as in Tally; blank = the company open in Tally at import."
        >
          <Input name="tally_company_name" defaultValue={company ?? ""} maxLength={120} />
        </Field>
        <Field
          label="Cost category"
          hint="The Tally cost category that holds the branch cost centres."
        >
          <Input name="tally_cost_category" defaultValue={costCategory} maxLength={120} required />
        </Field>
      </div>
    </ActionForm>
  );
}
