"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { ActionForm, Field, FormSheet, RunButton, selectClass } from "@/components/finance/forms";
import { Input } from "@/components/ui/input";
import { RULE_KINDS } from "@/lib/accounting/posting/rules";
import {
  POSTING_SOURCE_LABELS,
  POSTING_SOURCES,
  RULE_KIND_LIST,
  type PostingSettings,
  type RuleKind,
} from "@/lib/accounting/posting/types";

import {
  deletePostingRule,
  savePostingRule,
  savePostingSettings,
  seedPostingRules,
} from "./actions";

type Option = { id: string; code: string; name: string };

export type RuleFormValue = {
  id?: string;
  kind: RuleKind;
  key: string;
  qualifier: string;
  account_id?: string | null;
  tax_code_id?: string | null;
  note?: string | null;
  active?: boolean;
};

export function RuleButton({
  rule,
  accounts,
  taxCodes,
  trigger,
}: {
  rule?: RuleFormValue;
  accounts: Option[];
  taxCodes: Option[];
  trigger?: string;
}) {
  const router = useRouter();
  const [kind, setKind] = React.useState<RuleKind>(rule?.kind ?? "revenue");
  const info = RULE_KINDS[kind];
  return (
    <FormSheet
      trigger={trigger ?? (rule?.id ? "Edit" : "Add rule")}
      title={rule?.id ? "Edit posting rule" : "Add a posting rule"}
      description="Which account an amount posts to. '*' means any; the most specific rule wins."
      variant={rule?.id ? "ghost" : trigger ? "outline" : "default"}
      size="sm"
    >
      {(close) => (
        <ActionForm
          action={savePostingRule}
          onDone={() => {
            close();
            router.refresh();
          }}
        >
          {rule?.id && <input type="hidden" name="id" value={rule.id} />}
          <Field label="Kind" hint={info.help}>
            <select
              name="kind"
              className={selectClass}
              value={kind}
              onChange={(e) => setKind(e.target.value as RuleKind)}
              disabled={!!rule?.id}
            >
              {RULE_KIND_LIST.map((k) => (
                <option key={k} value={k}>
                  {RULE_KINDS[k].label}
                </option>
              ))}
            </select>
            {rule?.id && <input type="hidden" name="kind" value={kind} />}
          </Field>
          {info.key ? (
            <Field label={info.key} hint="'*' for any.">
              <Input name="key" defaultValue={rule?.key ?? "*"} maxLength={80} required />
            </Field>
          ) : (
            <input type="hidden" name="key" value="*" />
          )}
          {info.qualifier ? (
            <Field label={info.qualifier} hint="'*' for any.">
              <Input name="qualifier" defaultValue={rule?.qualifier ?? "*"} maxLength={80} />
            </Field>
          ) : (
            <input type="hidden" name="qualifier" value="*" />
          )}
          {info.target !== "tax" && (
            <Field label="Account">
              <select
                name="account_id"
                className={selectClass}
                defaultValue={rule?.account_id ?? ""}
                required
              >
                <option value="">Choose an account</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {info.target !== "account" && (
            <Field
              label={info.target === "tax" ? "VAT code" : "Tax code (optional)"}
              hint={
                info.target === "tax"
                  ? "The tax adviser's decision (OQ-120). Never guessed."
                  : "Blocked VAT makes the VAT part of the cost; reverse charge books 5% both ways."
              }
            >
              <select
                name="tax_code_id"
                className={selectClass}
                defaultValue={rule?.tax_code_id ?? ""}
                required={info.target === "tax"}
              >
                <option value="">{info.target === "tax" ? "Choose a VAT code" : "None"}</option>
                {taxCodes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.code} {t.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Note" hint="Optional.">
            <Input name="note" defaultValue={rule?.note ?? ""} maxLength={200} />
          </Field>
          {rule?.id && (
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" name="active" defaultChecked={rule.active ?? true} /> Active
            </label>
          )}
        </ActionForm>
      )}
    </FormSheet>
  );
}

export function DeleteRuleButton({ id }: { id: string }) {
  const router = useRouter();
  return (
    <RunButton
      action={() => deletePostingRule(id)}
      confirm="Remove this rule? Items that need it will wait until another rule covers them."
      variant="ghost"
      onDone={() => router.refresh()}
    >
      Remove
    </RunButton>
  );
}

export function SeedRulesButton() {
  const router = useRouter();
  return (
    <RunButton action={() => seedPostingRules()} onDone={() => router.refresh()}>
      Add missing defaults
    </RunButton>
  );
}

export function SettingsForm({ settings }: { settings: PostingSettings }) {
  const router = useRouter();
  return (
    <ActionForm
      action={savePostingSettings}
      submitLabel="Save settings"
      onDone={() => router.refresh()}
    >
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="denial_allowance_enabled"
          defaultChecked={settings.denialAllowanceEnabled}
        />
        Final denials use the expected-rejection allowance instead of the write-off account (OQ-126)
      </label>
      <Field
        label="Package invoices"
        hint="Held until the clinic decides how packages and deposits are recognised (OQ-127)."
      >
        <select
          name="package_invoices"
          className={selectClass}
          defaultValue={settings.packageInvoices}
        >
          <option value="hold">Hold (wait)</option>
          <option value="post">Post as revenue when invoiced</option>
        </select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Rounding tolerance (AED)" hint="Invoice total vs its lines.">
          <Input
            name="rounding_tolerance"
            type="number"
            step="0.01"
            min="0"
            max="100"
            defaultValue={settings.roundingTolerance}
          />
        </Field>
        <Field label="VAT tolerance (AED)" hint="Unite's VAT on a line vs its code's rate.">
          <Input
            name="vat_tolerance"
            type="number"
            step="0.01"
            min="0"
            max="10"
            defaultValue={settings.vatTolerance}
          />
        </Field>
      </div>
      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="mb-1 font-medium">
          Paused sources (not posted or previewed until switched back on)
        </legend>
        {POSTING_SOURCES.map((s) => (
          <label key={s} className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              name={`pause_${s}`}
              defaultChecked={settings.pausedSources.includes(s)}
            />{" "}
            {POSTING_SOURCE_LABELS[s]}
          </label>
        ))}
      </fieldset>
    </ActionForm>
  );
}
