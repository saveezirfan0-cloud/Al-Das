"use client";

import { useRouter } from "next/navigation";

import { ActionForm, Field, FormSheet } from "@/components/finance/forms";
import { Input } from "@/components/ui/input";

import { saveCostCentre } from "./actions";

export function CostCentreButton({
  centre,
}: {
  centre?: { id: string; code: string; name: string; active: boolean };
}) {
  const router = useRouter();
  return (
    <FormSheet
      trigger={centre ? "Edit" : "Add cost centre"}
      title={centre ? `Edit ${centre.code}` : "Add a cost centre"}
      description="For projects and units the branch, department and doctor dimensions do not cover (for example the leased unit)."
      variant={centre ? "ghost" : "default"}
      size="sm"
    >
      {(close) => (
        <ActionForm
          action={saveCostCentre}
          onDone={() => {
            close();
            router.refresh();
          }}
        >
          {centre && <input type="hidden" name="id" value={centre.id} />}
          <Field label="Code">
            <Input name="code" defaultValue={centre?.code ?? ""} maxLength={20} required />
          </Field>
          <Field label="Name">
            <Input name="name" defaultValue={centre?.name ?? ""} maxLength={80} required />
          </Field>
          {centre && (
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" name="active" defaultChecked={centre.active} /> Active
            </label>
          )}
        </ActionForm>
      )}
    </FormSheet>
  );
}
