"use client";

import * as React from "react";

import { ActionForm, Field, FormSheet, RunButton, selectClass } from "@/components/finance/forms";
import { Input } from "@/components/ui/input";
import {
  AMOUNT_STYLES,
  DATE_FORMATS,
  fieldsFor,
  IMPORT_KIND_KEYS,
  IMPORT_KINDS,
  type AmountStyle,
  type ImportKind,
} from "@/lib/finance/import-kinds";

import {
  addStarterRules,
  deleteRule,
  saveAccount,
  saveBankSettings,
  saveFormat,
  saveRule,
} from "./actions";

export type AccountView = {
  id: string;
  name: string;
  bank_name: string;
  last4: string;
  currency: string;
  ledger_name: string | null;
  receives_insurance: boolean;
  active: boolean;
};
export type FormatView = {
  id: string;
  kind: string;
  name: string;
  mapping: Record<string, string>;
  date_format: string;
  amount_style: string;
  active: boolean;
};
export type RuleView = {
  id: string;
  payment_mode: string;
  lag_days: number | null;
  fee_pct: number | null;
  account_id: string | null;
  settles_to_bank: boolean;
  source: string;
};
export type BankSettingsView = {
  weekendDays: number[];
  windowDays: number;
  toleranceAmount: number;
  tolerancePct: number;
  autoAcceptScore: number;
  cutoffDay: number;
};

const Check = ({ name, label, checked }: { name: string; label: string; checked: boolean }) => (
  <label className="flex items-center gap-2 text-sm">
    <input type="checkbox" name={name} defaultChecked={checked} /> {label}
  </label>
);

export function AccountButton({ account }: { account?: AccountView }) {
  return (
    <FormSheet
      trigger={account ? "Edit" : "Add account"}
      title={account ? `Edit ${account.name}` : "Add a bank account"}
      description="Only the last 4 digits of the account number are kept."
      variant={account ? "ghost" : "outline"}
      size="sm"
    >
      {(close) => (
        <ActionForm action={saveAccount} submitLabel="Save account" onDone={close}>
          <input type="hidden" name="id" value={account?.id ?? ""} />
          <Field label="Name (for example Operating account)">
            <Input name="name" defaultValue={account?.name ?? ""} maxLength={60} required />
          </Field>
          <Field label="Bank">
            <Input
              name="bank_name"
              defaultValue={account?.bank_name ?? ""}
              maxLength={60}
              required
            />
          </Field>
          <Field label="Last 4 digits of the account number">
            <Input
              name="last4"
              defaultValue={account?.last4 ?? ""}
              inputMode="numeric"
              maxLength={4}
              required
            />
          </Field>
          <Field label="Currency">
            <Input
              name="currency"
              defaultValue={account?.currency ?? "AED"}
              maxLength={3}
              required
            />
          </Field>
          <Field label="Ledger name in Tally (optional)">
            <Input name="ledger_name" defaultValue={account?.ledger_name ?? ""} maxLength={100} />
          </Field>
          <Check
            name="receives_insurance"
            label="Insurers' payments arrive in this account (one account only)"
            checked={account?.receives_insurance ?? false}
          />
          <Check name="active" label="Active" checked={account?.active ?? true} />
        </ActionForm>
      )}
    </FormSheet>
  );
}

function FormatFields({ format }: { format?: FormatView }) {
  const [kind, setKind] = React.useState<ImportKind>(
    (format?.kind as ImportKind) ?? "bank_statement",
  );
  const [style, setStyle] = React.useState<AmountStyle>(
    (format?.amount_style as AmountStyle) ?? "signed",
  );
  const styled = IMPORT_KINDS[kind].usesAmountStyle;
  return (
    <>
      <Field label="Kind of file">
        <select
          name="kind"
          className={selectClass}
          value={kind}
          disabled={!!format}
          onChange={(e) => setKind(e.target.value as ImportKind)}
        >
          {IMPORT_KIND_KEYS.map((k) => (
            <option key={k} value={k}>
              {IMPORT_KINDS[k].label}
            </option>
          ))}
        </select>
        {format && <input type="hidden" name="kind" value={kind} />}
      </Field>
      <Field label="Layout name (for example Bank X statement)">
        <Input name="name" defaultValue={format?.name ?? ""} maxLength={60} required />
      </Field>
      <Field label="Dates in the file are written">
        <select
          name="date_format"
          defaultValue={format?.date_format ?? "DD/MM/YYYY"}
          className={selectClass}
        >
          {DATE_FORMATS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </Field>
      {styled && (
        <Field label="Amounts are in">
          <select
            name="amount_style"
            className={selectClass}
            value={style}
            onChange={(e) => setStyle(e.target.value as AmountStyle)}
          >
            {AMOUNT_STYLES.map((a) => (
              <option key={a} value={a}>
                {a === "signed"
                  ? "One signed column (money in positive)"
                  : "Separate debit and credit columns"}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="flex flex-col gap-2 rounded-md border p-3">
        <div className="text-sm font-medium">Column headers, exactly as in the file</div>
        <p className="text-muted-foreground text-xs">
          Only these columns are read; every other column is ignored. A file missing one of them is
          refused.
        </p>
        {fieldsFor(kind, styled ? style : "signed").map(({ key, spec, required }) => (
          <Field key={key} label={`${spec.label}${required ? "" : " (optional)"}`} hint={spec.hint}>
            <Input
              name={`col_${key}`}
              defaultValue={format?.mapping?.[key] ?? ""}
              maxLength={80}
              required={required}
            />
          </Field>
        ))}
      </div>
      <Check name="active" label="Active" checked={format?.active ?? true} />
    </>
  );
}

export function FormatButton({ format }: { format?: FormatView }) {
  return (
    <FormSheet
      trigger={format ? "Edit" : "Add layout"}
      title={format ? `Edit ${format.name}` : "Add a file layout"}
      description="Map each field to the header of its column. Set this up once per bank or processor when the first sample file arrives."
      variant={format ? "ghost" : "outline"}
      size="sm"
    >
      {(close) => (
        <ActionForm action={saveFormat} submitLabel="Save layout" onDone={close}>
          <input type="hidden" name="id" value={format?.id ?? ""} />
          <FormatFields format={format} />
        </ActionForm>
      )}
    </FormSheet>
  );
}

export function RuleButton({
  rule,
  accounts,
}: {
  rule?: RuleView;
  accounts: Array<{ id: string; label: string }>;
}) {
  return (
    <FormSheet
      trigger={rule ? "Edit" : "Add rule"}
      title={rule ? `Rule for ${rule.payment_mode}` : "Add a settlement rule"}
      description="A payment mode is reconciled once it has a bank account, a lag and a fee % (0 when there is no fee)."
      variant={rule ? "ghost" : "outline"}
      size="sm"
    >
      {(close) => (
        <div className="flex flex-col gap-6">
          <ActionForm action={saveRule} submitLabel="Save rule" onDone={close}>
            <input type="hidden" name="id" value={rule?.id ?? ""} />
            <Field label="Payment mode, exactly as Unite writes it">
              <Input
                name="payment_mode"
                defaultValue={rule?.payment_mode ?? ""}
                maxLength={60}
                required
              />
            </Field>
            <Field
              label="Settles after (working days)"
              hint="Card and EPG 2, Tabby 6, cash deposit 1. Blank = not set yet."
            >
              <Input name="lag_days" defaultValue={rule?.lag_days ?? ""} inputMode="numeric" />
            </Field>
            <Field
              label="Expected fee (%)"
              hint="Deducted by the processor before the money reaches the bank."
            >
              <Input name="fee_pct" defaultValue={rule?.fee_pct ?? ""} inputMode="decimal" />
            </Field>
            <Field label="Paid into">
              <select
                name="account_id"
                defaultValue={rule?.account_id ?? ""}
                className={selectClass}
              >
                <option value="">Not chosen yet</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="What the bank is checked against">
              <select
                name="source"
                defaultValue={rule?.source ?? "collections"}
                className={selectClass}
              >
                <option value="collections">Unite collections, using the lag and fee above</option>
                <option value="settlement">The processor&apos;s settlement report (payouts)</option>
              </select>
            </Field>
            <Check
              name="settles_to_bank"
              label="Paid into a bank (untick for insurance credit)"
              checked={rule?.settles_to_bank ?? true}
            />
          </ActionForm>
          {rule && (
            <RunButton
              variant="destructive"
              confirm={`Delete the rule for ${rule.payment_mode}? Its collections will show as not reconciled.`}
              action={() => deleteRule({ id: rule.id })}
              onDone={close}
            >
              Delete rule
            </RunButton>
          )}
        </div>
      )}
    </FormSheet>
  );
}

export function StarterRulesButton() {
  return <RunButton action={() => addStarterRules()}>Add the starter rules</RunButton>;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function BankSettingsForm({ s }: { s: BankSettingsView }) {
  return (
    <ActionForm action={saveBankSettings} submitLabel="Save">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Month-end cut-off day"
          hint="30 = the period ends on the 30th (or the month's last day if shorter)."
        >
          <Input name="bank_cutoff_day" inputMode="numeric" defaultValue={s.cutoffDay} />
        </Field>
        <Field label="Date window (days either side of the expected date)">
          <Input name="bank_date_window_days" inputMode="numeric" defaultValue={s.windowDays} />
        </Field>
        <Field label="Amount tolerance (fixed)">
          <Input
            name="bank_amount_tolerance"
            inputMode="decimal"
            defaultValue={s.toleranceAmount}
          />
        </Field>
        <Field
          label="Amount tolerance (% of the expected amount)"
          hint="The larger of the two tolerances applies."
        >
          <Input
            name="bank_amount_tolerance_pct"
            inputMode="decimal"
            defaultValue={s.tolerancePct}
          />
        </Field>
        <Field
          label="Auto-accept score (50 to 100)"
          hint="And only when the pair is the only candidate on both sides."
        >
          <Input
            name="bank_auto_accept_score"
            inputMode="numeric"
            defaultValue={s.autoAcceptScore}
          />
        </Field>
      </div>
      <fieldset className="flex flex-wrap gap-3">
        <legend className="mb-1 text-sm font-medium">Weekend (not a banking day)</legend>
        {DAYS.map((d, i) => (
          <Check key={d} name={`wd_${i}`} label={d} checked={s.weekendDays.includes(i)} />
        ))}
      </fieldset>
    </ActionForm>
  );
}
