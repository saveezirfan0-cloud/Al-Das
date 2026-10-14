"use client";

import { useRouter } from "next/navigation";

import { ActionForm, Field } from "@/components/finance/forms";
import { Input } from "@/components/ui/input";

import { saveReportSettings } from "./actions";

export type ReportSettingsView = {
  acc_budget_variance_pct: number;
  acc_large_journal_amount: number;
  acc_ct_rate: number;
  acc_ct_threshold: number;
  acc_ct_entertainment_pct: number;
  acc_ct_sbr_limit: number;
  acc_ct_connected_limit: number;
};

export function ReportSettingsForm({
  values,
  editable,
}: {
  values: ReportSettingsView;
  editable: boolean;
}) {
  const router = useRouter();
  const field = (name: keyof ReportSettingsView, label: string, hint: string) => (
    <Field label={label} hint={hint}>
      <Input
        name={name}
        defaultValue={String(values[name])}
        inputMode="decimal"
        disabled={!editable}
        className="w-48"
      />
    </Field>
  );
  return (
    <ActionForm action={saveReportSettings} onDone={() => router.refresh()} disabled={!editable}>
      <h2 className="font-medium">Reports</h2>
      {field(
        "acc_budget_variance_pct",
        "Budget highlight (%)",
        "Lines worse than budget by more than this are highlighted.",
      )}
      {field(
        "acc_large_journal_amount",
        "Large manual journal (AED)",
        "Manual journals of this total or more appear on the exception report.",
      )}
      <h2 className="pt-2 font-medium">Corporate tax bridge (working paper)</h2>
      {field("acc_ct_rate", "Rate (%)", "Applied to taxable income above the 0% band.")}
      {field(
        "acc_ct_threshold",
        "0% band (AED)",
        "Taxable income up to this amount is taxed at 0%.",
      )}
      {field(
        "acc_ct_entertainment_pct",
        "Entertainment not deductible (%)",
        "The share of entertainment added back.",
      )}
      {field(
        "acc_ct_sbr_limit",
        "Small Business Relief revenue limit (AED)",
        "Shown as a note; the adviser decides the election.",
      )}
      {field(
        "acc_ct_connected_limit",
        "Connected-person disclosure limit (AED)",
        "Payments above this suggest the transfer pricing disclosure.",
      )}
    </ActionForm>
  );
}
