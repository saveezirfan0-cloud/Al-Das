"use client";

import { Input } from "@/components/ui/input";
import { ActionForm, Field, RunButton } from "@/components/finance/forms";

import {
  buildClosePackAction,
  signOffCeo,
  signOffFinance,
  withdrawFinanceSignoff,
} from "./actions";

export function BuildButton({ month, rebuild }: { month: string; rebuild: boolean }) {
  return (
    <RunButton
      variant={rebuild ? "outline" : "default"}
      size="default"
      confirm={
        rebuild ? "Rebuild the pack from today's figures? The current pack is replaced." : undefined
      }
      action={() => buildClosePackAction({ month })}
    >
      {rebuild ? "Rebuild the pack" : "Build the pack"}
    </RunButton>
  );
}

export function SignForm({
  who,
  id,
  month,
  hash,
}: {
  who: "finance" | "ceo";
  id: string;
  month: string;
  hash: string;
}) {
  const run = who === "finance" ? signOffFinance : signOffCeo;
  return (
    <ActionForm
      submitLabel={who === "finance" ? "Sign for Finance" : "Sign as CEO and lock the month"}
      action={async (v) => run({ id, month, hash, note: v.note ?? "" })}
    >
      <Field
        label="Note (optional)"
        hint={
          who === "ceo"
            ? "Signing locks the month. This cannot be undone."
            : "You are confirming you reviewed this pack."
        }
      >
        <Input name="note" maxLength={500} />
      </Field>
    </ActionForm>
  );
}

export function WithdrawButton({ id, month }: { id: string; month: string }) {
  return (
    <RunButton
      variant="outline"
      confirm="Withdraw your finance sign-off so the pack can be rebuilt?"
      action={() => withdrawFinanceSignoff({ id, month })}
    >
      Withdraw the finance sign-off
    </RunButton>
  );
}
