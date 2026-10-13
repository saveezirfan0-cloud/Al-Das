"use client";

import { useRouter } from "next/navigation";

import { ActionForm, Field, FormSheet, selectClass } from "@/components/finance/forms";
import { Input } from "@/components/ui/input";
import { MONTH_NAMES } from "@/lib/accounting/numbering";

import { saveBranchMapping, saveEntity } from "./actions";

export type EntityFormView = {
  id: string;
  name: string;
  trn: string | null;
  base_currency: string;
  fiscal_year_start_month: number;
  active: boolean;
  is_default: boolean;
  hasYears: boolean;
};

export function EntityButton({ entity }: { entity?: EntityFormView }) {
  const router = useRouter();
  return (
    <FormSheet
      trigger={entity ? "Edit" : "Add entity"}
      title={entity ? `Edit ${entity.name}` : "Add a legal entity"}
      description="A legal entity keeps its own books (its own TRN and fiscal year). Al Das is one entity today."
      variant={entity ? "ghost" : "outline"}
      size="sm"
    >
      {(close) => (
        <ActionForm
          action={saveEntity}
          onDone={() => {
            close();
            router.refresh();
          }}
        >
          {entity && <input type="hidden" name="id" value={entity.id} />}
          <Field label="Legal name">
            <Input name="name" defaultValue={entity?.name ?? ""} maxLength={120} required />
          </Field>
          <Field label="Tax registration number (TRN)" hint="Optional.">
            <Input name="trn" defaultValue={entity?.trn ?? ""} maxLength={20} />
          </Field>
          <Field label="Base currency">
            <Input
              name="base_currency"
              defaultValue={entity?.base_currency ?? "AED"}
              maxLength={3}
            />
          </Field>
          <Field
            label="Fiscal year starts in"
            hint={
              entity?.hasYears
                ? "Fixed: a fiscal year already exists."
                : "July for a July to June year; January for the calendar year."
            }
          >
            {entity?.hasYears && (
              <input
                type="hidden"
                name="fiscal_year_start_month"
                value={entity.fiscal_year_start_month}
              />
            )}
            <select
              name={entity?.hasYears ? undefined : "fiscal_year_start_month"}
              className={selectClass}
              defaultValue={entity?.fiscal_year_start_month ?? 7}
              disabled={entity?.hasYears}
            >
              {MONTH_NAMES.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          {entity && !entity.is_default && (
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" name="active" defaultChecked={entity.active} /> Active
            </label>
          )}
          {entity?.is_default && <input type="hidden" name="active" value="on" />}
        </ActionForm>
      )}
    </FormSheet>
  );
}

export function BranchForm({
  branch,
  entities,
  emirates,
}: {
  branch: { code: string; entity_id: string; emirate: string };
  entities: Array<{ id: string; name: string }>;
  emirates: readonly string[];
}) {
  const router = useRouter();
  return (
    <ActionForm
      action={saveBranchMapping}
      submitLabel="Save"
      variant="outline"
      className="flex-row flex-wrap items-end"
      onDone={() => router.refresh()}
    >
      <input type="hidden" name="branch_code" value={branch.code} />
      {entities.length > 1 ? (
        <select name="entity_id" className={`${selectClass} w-48`} defaultValue={branch.entity_id}>
          {entities.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      ) : (
        <input type="hidden" name="entity_id" value={branch.entity_id || entities[0]?.id || ""} />
      )}
      <select name="emirate" className={`${selectClass} w-44`} defaultValue={branch.emirate}>
        {emirates.map((e) => (
          <option key={e} value={e}>
            {e}
          </option>
        ))}
      </select>
    </ActionForm>
  );
}
