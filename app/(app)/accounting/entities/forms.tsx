"use client";

import { useRouter } from "next/navigation";

import { ActionForm, Field, FormSheet, selectClass } from "@/components/finance/forms";
import { Input } from "@/components/ui/input";
import { MONTH_NAMES } from "@/lib/accounting/numbering";

import { saveBranchMapping, saveEntity, setLedgerStart } from "./actions";

export type EntityFormView = {
  id: string;
  name: string;
  trn: string | null;
  base_currency: string;
  fiscal_year_start_month: number;
  active: boolean;
  is_default: boolean;
  hasYears: boolean;
  tally_company: string | null;
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
          <Field
            label="Tally company"
            hint={
              entity?.is_default
                ? "Exactly as TallyPrime names it. Leave empty to use the company set under Settings, Integrations, Tally bridge. Cannot be changed once the bridge has exchanged data with it."
                : "Exactly as TallyPrime names it. Without one this entity is not sent to Tally. Cannot be changed once the bridge has exchanged data with it."
            }
          >
            <Input
              name="tally_company"
              defaultValue={entity?.tally_company ?? ""}
              maxLength={120}
            />
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

/** The ledger start (Phase 22D): typed confirmation; the database refuses a move that would post anything twice. */
export function LedgerStartButton({
  entityId,
  current,
}: {
  entityId: string;
  current: string | null;
}) {
  const router = useRouter();
  return (
    <FormSheet
      trigger={current ? "Ledger start" : "Set ledger start"}
      title="Ledger start"
      description="The first day Pulse is the book of record. Before it Tally is, and Pulse only previews its postings (nothing is posted twice). Once Pulse has posted, the date cannot be cleared, moved earlier, or moved past its first journal."
      variant="outline"
      size="sm"
    >
      {(close) => (
        <ActionForm
          action={setLedgerStart}
          submitLabel="Save the ledger start"
          onDone={() => {
            close();
            router.refresh();
          }}
        >
          <input type="hidden" name="entity_id" value={entityId} />
          <Field
            label="Ledger start date"
            hint="Best a fiscal-year or quarter start after the last Tally month (OQ-117)."
          >
            <Input type="date" name="date" defaultValue={current ?? ""} required />
          </Field>
          <Field label="Type START to confirm">
            <Input name="confirm" autoComplete="off" required />
          </Field>
        </ActionForm>
      )}
    </FormSheet>
  );
}
