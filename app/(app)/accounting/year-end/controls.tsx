"use client";

import { useRouter } from "next/navigation";

import { ActionForm, Field, FormSheet, RunButton } from "@/components/finance/forms";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { closeYear, closeYearMonths, reopenYear } from "./actions";

export function YearEndControls({
  id,
  status,
  canClose,
  monthsOpen,
}: {
  id: string;
  status: string;
  canClose: boolean;
  monthsOpen: boolean;
}) {
  const router = useRouter();
  const done = () => router.refresh();
  if (status === "closed")
    return (
      <FormSheet
        trigger="Re-open the year"
        title="Re-open the year"
        description="Reverses the closing journal (dated the year's last day) so the year takes postings again. Close it again when the corrections are posted."
        variant="outline"
      >
        {(close) => (
          <ActionForm
            action={(v) => reopenYear({ ...v, id })}
            submitLabel="Re-open"
            variant="destructive"
            onDone={() => {
              close();
              done();
            }}
          >
            <Field label="Why">
              <Textarea name="reason" required maxLength={200} />
            </Field>
            <Field label="Type REOPEN to confirm">
              <Input name="confirm" autoComplete="off" required />
            </Field>
          </ActionForm>
        )}
      </FormSheet>
    );
  return (
    <div className="flex flex-wrap gap-2">
      {monthsOpen && (
        <RunButton
          action={() => closeYearMonths(id)}
          onDone={done}
          confirm="Close every open month of this year? People who manage periods can still post into a closed month."
        >
          Close the twelve months
        </RunButton>
      )}
      {canClose && (
        <FormSheet
          trigger="Close the year"
          title="Close the year"
          description="Posts the closing journal (every income and expense balance to retained earnings) and closes the year. Nothing can be posted into it afterwards until it is re-opened."
        >
          {(close) => (
            <ActionForm
              action={(v) => closeYear({ ...v, id })}
              submitLabel="Close the year"
              onDone={() => {
                close();
                done();
              }}
            >
              <Field label="Type CLOSE to confirm">
                <Input name="confirm" autoComplete="off" required />
              </Field>
            </ActionForm>
          )}
        </FormSheet>
      )}
    </div>
  );
}
