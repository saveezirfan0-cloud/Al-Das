"use client";

import * as React from "react";

import { ActionForm, Field, FormSheet, RunButton, selectClass } from "@/components/finance/forms";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PROVIDER_KINDS } from "@/lib/finance/labs";

import { deleteProviderTest, saveLabSettings, saveProvider, saveProviderTests } from "./actions";

export type ProviderView = {
  id: string;
  name: string;
  kind: string;
  fixed_monthly_fee: number | null;
  allocation_basis: string;
  active: boolean;
};

export function ProviderButton({ provider }: { provider?: ProviderView }) {
  const [kind, setKind] = React.useState(provider?.kind ?? "send_out_lab");
  return (
    <FormSheet
      trigger={provider ? "Edit" : "Add provider"}
      title={provider ? `Edit ${provider.name}` : "Add a provider"}
      description="The kind decides which file the provider sends and where its cost is charged (lab or referral). It cannot change once saved."
      variant={provider ? "ghost" : "outline"}
      size="sm"
    >
      {(close) => (
        <ActionForm action={saveProvider} submitLabel="Save provider" onDone={close}>
          <input type="hidden" name="id" value={provider?.id ?? ""} />
          <Field label="Name">
            <Input name="name" defaultValue={provider?.name ?? ""} maxLength={80} required />
          </Field>
          <Field label="Kind">
            <select
              name="kind"
              className={selectClass}
              value={kind}
              disabled={!!provider}
              onChange={(e) => setKind(e.target.value)}
            >
              {Object.entries(PROVIDER_KINDS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            {provider && <input type="hidden" name="kind" value={kind} />}
          </Field>
          {kind === "in_house_lab" && (
            <>
              <Field
                label="Fixed monthly fee (AED)"
                hint="Unlimited tests for this amount a month."
              >
                <Input
                  name="fixed_monthly_fee"
                  defaultValue={provider?.fixed_monthly_fee ?? ""}
                  inputMode="decimal"
                />
              </Field>
              <Field label="Share the fee between doctors by">
                <select
                  name="allocation_basis"
                  className={selectClass}
                  defaultValue={provider?.allocation_basis ?? "test_count"}
                >
                  <option value="test_count">Number of tests</option>
                  <option value="revenue">Billed revenue of the matched tests</option>
                </select>
              </Field>
            </>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="active" defaultChecked={provider?.active ?? true} /> Active
          </label>
        </ActionForm>
      )}
    </FormSheet>
  );
}

export function TestsButton({
  providerId,
  providerName,
}: {
  providerId: string;
  providerName: string;
}) {
  return (
    <FormSheet
      trigger="Add or update tests"
      title={`Tests of ${providerName}`}
      description="One test per line: code, expected days, agreed price. Either number may be left blank. Existing codes are updated, others are kept."
      variant="outline"
      size="sm"
    >
      {(close) => (
        <ActionForm action={saveProviderTests} submitLabel="Save tests" onDone={close}>
          <input type="hidden" name="provider_id" value={providerId} />
          <Field label="Tests" hint="For example: 85025, 1, 35  (no thousands separator)">
            <Textarea name="list" rows={10} required />
          </Field>
        </ActionForm>
      )}
    </FormSheet>
  );
}

export function DeleteTestButton({ id }: { id: string }) {
  return (
    <RunButton
      variant="ghost"
      confirm="Remove this test?"
      action={() => deleteProviderTest({ id })}
    >
      Remove
    </RunButton>
  );
}

export function LabSettingsForm({
  windowDays,
  priceTolerance,
}: {
  windowDays: number;
  priceTolerance: number;
}) {
  return (
    <ActionForm action={saveLabSettings} submitLabel="Save settings" className="sm:max-w-md">
      <Field
        label="Date window (days)"
        hint="How far apart the provider's service date and the Unite invoice date may be. Same-day pairs are made first."
      >
        <Input name="lab_date_window_days" defaultValue={windowDays} inputMode="numeric" required />
      </Field>
      <Field
        label="Price tolerance (AED)"
        hint="A line further than this from the agreed price is listed."
      >
        <Input
          name="lab_price_tolerance"
          defaultValue={priceTolerance}
          inputMode="decimal"
          required
        />
      </Field>
    </ActionForm>
  );
}
