"use client";

import { useRouter } from "next/navigation";

import { ActionForm, Field, FormSheet, selectClass } from "@/components/finance/forms";

import { saveVatSettings } from "./actions";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function VatSettingsButton({
  entityId,
  entityName,
  months,
  anchor,
  emirate,
  emirates,
}: {
  entityId: string;
  entityName: string;
  months: number;
  anchor: number;
  emirate: string;
  emirates: readonly string[];
}) {
  const router = useRouter();
  return (
    <FormSheet
      trigger="VAT settings"
      title={`VAT settings: ${entityName}`}
      description="As on the VAT certificate. The default emirate is used for a line that names no branch; such lines are flagged on the return."
      variant="outline"
      size="sm"
    >
      {(close) => (
        <ActionForm
          action={saveVatSettings}
          onDone={() => {
            close();
            router.refresh();
          }}
        >
          <input type="hidden" name="entity_id" value={entityId} />
          <Field label="Tax period">
            <select name="vat_period_months" defaultValue={String(months)} className={selectClass}>
              <option value="3">Quarterly</option>
              <option value="1">Monthly</option>
            </select>
          </Field>
          <Field
            label="A quarter starts in"
            hint="For example January means Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec."
          >
            <select
              name="vat_period_anchor_month"
              defaultValue={String(anchor)}
              className={selectClass}
            >
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Default emirate">
            <select name="default_emirate" defaultValue={emirate} className={selectClass}>
              {emirates.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </Field>
        </ActionForm>
      )}
    </FormSheet>
  );
}
