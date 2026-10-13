"use client";

import { useRouter } from "next/navigation";

import { ActionForm, Field, FormSheet, RunButton, selectClass } from "@/components/finance/forms";
import { Input } from "@/components/ui/input";
import { CONTROL_KINDS, CONTROL_LABELS } from "@/lib/accounting/accounts";
import {
  CASH_FLOW_CLASSES,
  CASH_FLOW_LABELS,
  type CashFlowClass,
} from "@/lib/accounting/statements/cash-flow";
import { CT_TREATMENT_LABELS, CT_TREATMENTS } from "@/lib/accounting/statements/corporate-tax";

import { deleteAccount, saveAccount, saveAccountReporting, setAccountActive } from "./actions";

export type AccountFormView = {
  id: string;
  parent_id: string | null;
  code: string;
  name: string;
  is_group: boolean;
  is_system: boolean;
  is_active: boolean;
  control: string | null;
  allow_manual: boolean;
  currency: string | null;
  description: string | null;
};

export type GroupOption = { id: string; label: string };

export function AccountButton({
  account,
  groups,
}: {
  account?: AccountFormView;
  groups: GroupOption[];
}) {
  const router = useRouter();
  const system = !!account?.is_system;
  return (
    <FormSheet
      trigger={account ? "Edit" : "Add account"}
      title={account ? `Edit ${account.code}` : "Add an account or group"}
      description={
        system
          ? "One of Tally's predefined groups: only its name and description can change."
          : "An account has the nature of its group. Ledgers take journal lines; groups hold ledgers."
      }
      variant={account ? "ghost" : "default"}
      size="sm"
    >
      {(close) => (
        <ActionForm
          action={saveAccount}
          submitLabel="Save"
          onDone={() => {
            close();
            router.refresh();
          }}
        >
          {account && <input type="hidden" name="id" value={account.id} />}
          {system && <input type="hidden" name="system" value="1" />}
          {system && <input type="hidden" name="code" value={account!.code} />}
          {!system && (
            <>
              <Field label="Group">
                <select
                  name="parent_id"
                  className={selectClass}
                  defaultValue={account?.parent_id ?? ""}
                  required
                >
                  <option value="" disabled>
                    Choose a group
                  </option>
                  {groups
                    .filter((g) => g.id !== account?.id)
                    .map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.label}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Code" hint="Letters and digits, for example 6210.">
                <Input name="code" defaultValue={account?.code ?? ""} maxLength={20} required />
              </Field>
            </>
          )}
          <Field label="Name">
            <Input name="name" defaultValue={account?.name ?? ""} maxLength={120} required />
          </Field>
          {!system && (
            <>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="is_group"
                  defaultChecked={account?.is_group ?? false}
                />
                This is a group (holds other accounts, takes no lines)
              </label>
              <Field
                label="Control account"
                hint="A control account takes automatic postings from the sub-ledgers only (and opening balances)."
              >
                <select
                  name="control"
                  className={selectClass}
                  defaultValue={account?.control ?? ""}
                >
                  <option value="">None</option>
                  {CONTROL_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {CONTROL_LABELS[k]}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="allow_manual"
                  defaultChecked={account?.allow_manual ?? true}
                />
                Manual journals may post to it
              </label>
              <Field label="Currency" hint="Leave blank for the entity's base currency (AED).">
                <Input name="currency" defaultValue={account?.currency ?? ""} maxLength={3} />
              </Field>
            </>
          )}
          <Field label="Description">
            <Input name="description" defaultValue={account?.description ?? ""} maxLength={300} />
          </Field>
        </ActionForm>
      )}
    </FormSheet>
  );
}

/** Reporting (Phase 22G): cash flow class, corporate tax treatment, required branch / cost centre. */
export function AccountReportingButton({
  account,
  effectiveClass,
}: {
  account: {
    id: string;
    code: string;
    nature: string;
    is_group: boolean;
    cash_flow_class: string | null;
    ct_treatment: string | null;
    requires_branch: boolean;
    requires_cost_centre: boolean;
  };
  effectiveClass: string | null;
}) {
  const router = useRouter();
  const pl = account.nature === "income" || account.nature === "expense";
  return (
    <FormSheet
      trigger="Reporting"
      title={`Reporting: ${account.code}`}
      description="How the account appears on the cash flow statement, the corporate tax bridge and the exception report. Posting is not affected."
      variant="ghost"
      size="sm"
    >
      {(close) => (
        <ActionForm
          action={saveAccountReporting}
          onDone={() => {
            close();
            router.refresh();
          }}
        >
          <input type="hidden" name="id" value={account.id} />
          {!pl && (
            <Field
              label="Cash flow class"
              hint={`Blank follows the group${effectiveClass ? ` (now: ${CASH_FLOW_LABELS[effectiveClass as CashFlowClass] ?? effectiveClass})` : ""}. Cash and bank control accounts are always cash.`}
            >
              <select
                name="cash_flow_class"
                className={selectClass}
                defaultValue={account.cash_flow_class ?? ""}
              >
                <option value="">From the group</option>
                {CASH_FLOW_CLASSES.map((k) => (
                  <option key={k} value={k}>
                    {CASH_FLOW_LABELS[k]}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {!account.is_group && account.nature === "expense" && (
            <Field
              label="Corporate tax treatment"
              hint="For the corporate tax bridge (a working paper)."
            >
              <select
                name="ct_treatment"
                className={selectClass}
                defaultValue={account.ct_treatment ?? ""}
              >
                <option value="">Deductible (no adjustment)</option>
                {CT_TREATMENTS.map((k) => (
                  <option key={k} value={k}>
                    {CT_TREATMENT_LABELS[k]}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {!account.is_group && (
            <>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="requires_branch"
                  defaultChecked={account.requires_branch}
                />
                Lines should carry a branch (listed on the exception report when missing)
              </label>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="requires_cost_centre"
                  defaultChecked={account.requires_cost_centre}
                />
                Lines should carry a cost centre
              </label>
            </>
          )}
          {account.is_group && pl && (
            <p className="text-muted-foreground text-sm">
              Income and expense groups have nothing to set here.
            </p>
          )}
        </ActionForm>
      )}
    </FormSheet>
  );
}

export function AccountActiveButton({ id, active }: { id: string; active: boolean }) {
  const router = useRouter();
  return (
    <RunButton
      variant="ghost"
      action={() => setAccountActive({ id, active: !active })}
      onDone={() => router.refresh()}
    >
      {active ? "Deactivate" : "Activate"}
    </RunButton>
  );
}

export function DeleteAccountButton({ id }: { id: string }) {
  const router = useRouter();
  return (
    <RunButton
      variant="ghost"
      confirm="Delete this account? Only an account that was never used can be deleted."
      action={() => deleteAccount({ id })}
      onDone={() => router.refresh()}
    >
      Delete
    </RunButton>
  );
}
