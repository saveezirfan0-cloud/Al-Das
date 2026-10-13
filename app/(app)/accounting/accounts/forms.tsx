"use client";

import { useRouter } from "next/navigation";

import { ActionForm, Field, FormSheet, RunButton, selectClass } from "@/components/finance/forms";
import { Input } from "@/components/ui/input";
import { CONTROL_KINDS, CONTROL_LABELS } from "@/lib/accounting/accounts";

import { deleteAccount, saveAccount, setAccountActive } from "./actions";

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
