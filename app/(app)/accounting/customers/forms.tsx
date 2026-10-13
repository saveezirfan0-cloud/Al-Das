"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { ActionForm, Field, FormSheet, selectClass } from "@/components/finance/forms";
import { Input } from "@/components/ui/input";
import { EMIRATES } from "@/lib/accounting/accounts";
import { CUSTOMER_KIND_LABELS, CUSTOMER_KINDS, type CustomerKind } from "@/lib/accounting/sales";

import { saveCustomer } from "./actions";

export type CustomerFormValue = {
  id: string;
  kind: CustomerKind;
  name: string;
  trn: string | null;
  emirate: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  country: string;
  email: string | null;
  credit_terms_days: number;
  connected_person: boolean;
  payer_id: string | null;
  receivable_account_id: string | null;
  active: boolean;
};

type Opt = { id: string; label: string };

export function CustomerButton({
  customer,
  payers,
  receivableAccounts,
}: {
  customer?: CustomerFormValue;
  payers: Opt[];
  receivableAccounts: Opt[];
}) {
  const router = useRouter();
  const [kind, setKind] = React.useState<CustomerKind>(customer?.kind ?? "corporate");
  return (
    <FormSheet
      trigger={customer ? "Edit" : "Add customer"}
      title={customer ? `Edit ${customer.name}` : "Add a customer"}
      description="Insurers, corporates, tenants and other businesses Pulse invoices. Patients are invoiced in Unite, not here."
      variant={customer ? "ghost" : "default"}
      size="sm"
    >
      {(close) => (
        <ActionForm
          action={saveCustomer}
          onDone={() => {
            close();
            router.refresh();
          }}
        >
          {customer && <input type="hidden" name="id" value={customer.id} />}
          <Field label="Kind">
            <select
              name="kind"
              className={selectClass}
              value={kind}
              onChange={(e) => setKind(e.target.value as CustomerKind)}
            >
              {CUSTOMER_KINDS.map((k) => (
                <option key={k} value={k}>
                  {CUSTOMER_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Name">
            <Input name="name" defaultValue={customer?.name ?? ""} maxLength={120} required />
          </Field>
          {kind === "insurer" && (
            <Field label="Payer" hint="Links the insurer to its payer so statements can include remittances later.">
              <select name="payer_id" defaultValue={customer?.payer_id ?? ""} className={selectClass}>
                <option value="">Not linked</option>
                {payers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="TRN" hint="Leave blank when the customer is not VAT registered.">
            <Input name="trn" defaultValue={customer?.trn ?? ""} maxLength={20} />
          </Field>
          <Field label="Address line 1">
            <Input name="address_line1" defaultValue={customer?.address_line1 ?? ""} maxLength={120} />
          </Field>
          <Field label="Address line 2">
            <Input name="address_line2" defaultValue={customer?.address_line2 ?? ""} maxLength={120} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="City">
              <Input name="city" defaultValue={customer?.city ?? ""} maxLength={60} />
            </Field>
            <Field label="Emirate">
              <select name="emirate" defaultValue={customer?.emirate ?? ""} className={selectClass}>
                <option value="">Outside the UAE / not set</option>
                {EMIRATES.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Country">
            <Input
              name="country"
              defaultValue={customer?.country ?? "United Arab Emirates"}
              maxLength={60}
              required
            />
          </Field>
          <Field label="Accounts e-mail" hint="A business address for statements; never a patient's.">
            <Input type="email" name="email" defaultValue={customer?.email ?? ""} maxLength={200} />
          </Field>
          <Field label="Credit terms (days)">
            <Input
              type="number"
              name="credit_terms_days"
              min={0}
              max={365}
              defaultValue={customer?.credit_terms_days ?? 30}
              required
            />
          </Field>
          <Field label="Receivable account" hint="Leave on the default unless the accountant asks.">
            <select
              name="receivable_account_id"
              defaultValue={customer?.receivable_account_id ?? ""}
              className={selectClass}
            >
              <option value="">Default (Customer receivables)</option>
              {receivableAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </Field>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" name="connected_person" defaultChecked={customer?.connected_person} />{" "}
            Connected person (corporate tax)
          </label>
          {customer && (
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" name="active" defaultChecked={customer.active} /> Active
            </label>
          )}
        </ActionForm>
      )}
    </FormSheet>
  );
}
