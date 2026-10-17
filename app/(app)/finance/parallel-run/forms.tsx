"use client";

import { ActionForm, Field, FormSheet } from "@/components/finance/forms";
import { Input } from "@/components/ui/input";
import { AREA_LABEL, type Area } from "@/lib/finance/parallel-run";

import { saveManualFigure, saveTolerance, setDecision } from "./actions";

const NO_NAMES = "Do not type patients' names or numbers here.";

export function ManualFigureButton({
  area,
  month,
  manual,
  note,
}: {
  area: Area;
  month: string;
  manual: number | null;
  note: string | null;
}) {
  return (
    <FormSheet
      trigger={manual === null ? "Enter" : "Edit"}
      title={`${AREA_LABEL[area]}, ${month}`}
      description={`The figure Finance produced by hand for this month, in AED, on the same basis as Pulse's. ${NO_NAMES}`}
      variant="ghost"
      size="sm"
    >
      {(close) => (
        <ActionForm action={saveManualFigure} onDone={close} submitLabel="Save figure">
          <input type="hidden" name="area" value={area} />
          <input type="hidden" name="month" value={month} />
          <Field label="Manual figure (AED)">
            <Input
              name="amount"
              inputMode="decimal"
              defaultValue={manual === null ? "" : String(manual)}
              required
            />
          </Field>
          <Field label="Explanation of any difference" hint={NO_NAMES}>
            <Input name="note" defaultValue={note ?? ""} maxLength={500} />
          </Field>
        </ActionForm>
      )}
    </FormSheet>
  );
}

export function DecisionButton({ area, status }: { area: Area; status: "running" | "switched" }) {
  const switching = status === "switched";
  return (
    <FormSheet
      trigger={switching ? "Mark as switched to Pulse" : "Back to running in parallel"}
      title={`${AREA_LABEL[area]}: ${switching ? "rely on Pulse" : "keep the manual process"}`}
      description={
        switching
          ? "Records that Finance relies on Pulse's figure for this area from now on, with your name and the time. Nothing is posted and the manual process is not switched off by Pulse."
          : "Records that this area runs in parallel again, with your name and the time."
      }
      variant={switching ? "default" : "outline"}
      size="sm"
    >
      {(close) => (
        <ActionForm
          action={setDecision}
          onDone={close}
          submitLabel={switching ? "Record decision" : "Record reversal"}
        >
          <input type="hidden" name="area" value={area} />
          <input type="hidden" name="status" value={status} />
          <Field label="Note (optional)" hint={NO_NAMES}>
            <Input name="note" maxLength={500} />
          </Field>
        </ActionForm>
      )}
    </FormSheet>
  );
}

export function ToleranceForm({ tolerance }: { tolerance: number }) {
  return (
    <ActionForm action={saveTolerance} className="flex-row flex-wrap items-end" submitLabel="Save">
      <Field label="Agrees when the difference is within (AED)">
        <Input name="tolerance" inputMode="decimal" defaultValue={String(tolerance)} required />
      </Field>
    </ActionForm>
  );
}
