"use client";

import { useRouter } from "next/navigation";

import { ActionForm, Field, FormSheet, RunButton, selectClass } from "@/components/finance/forms";
import { Input } from "@/components/ui/input";

import { createPeriod, setPeriodStatus } from "./actions";

export function PeriodButtons({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const done = () => router.refresh();
  if (status === "open")
    return (
      <RunButton action={() => setPeriodStatus({ id, status: "closed" })} onDone={done}>
        Close
      </RunButton>
    );
  if (status === "closed")
    return (
      <div className="flex flex-wrap justify-end gap-1">
        <RunButton action={() => setPeriodStatus({ id, status: "open" })} onDone={done}>
          Reopen
        </RunButton>
        <FormSheet
          trigger="Lock"
          title="Lock this period"
          description="Nothing can ever be posted into a locked period again, by anyone. Corrections go into an open period."
          variant="outline"
          size="sm"
        >
          {(close) => (
            <ActionForm
              action={(v) => setPeriodStatus({ id, status: "locked", confirm: v.confirm ?? "" })}
              submitLabel="Lock for good"
              variant="destructive"
              onDone={() => {
                close();
                done();
              }}
            >
              <Field label="Type LOCK to confirm">
                <Input name="confirm" autoComplete="off" required />
              </Field>
            </ActionForm>
          )}
        </FormSheet>
      </div>
    );
  return null;
}

export function CreatePeriodButton({
  entities,
  today,
}: {
  entities: Array<{ id: string; name: string }>;
  today: string;
}) {
  const router = useRouter();
  return (
    <FormSheet
      trigger="Add a period"
      title="Add a period"
      description="Periods are created by the first posting in their month. Add one ahead of time to close or lock it."
      size="sm"
    >
      {(close) => (
        <ActionForm
          action={createPeriod}
          submitLabel="Add"
          onDone={() => {
            close();
            router.refresh();
          }}
        >
          {entities.length > 1 && (
            <Field label="Entity">
              <select name="entity_id" className={selectClass}>
                {entities.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Any date in the month">
            <Input type="date" name="date" defaultValue={today} required />
          </Field>
        </ActionForm>
      )}
    </FormSheet>
  );
}
