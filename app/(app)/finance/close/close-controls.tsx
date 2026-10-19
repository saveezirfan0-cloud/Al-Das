"use client";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ActionForm, Field, RunButton } from "@/components/finance/forms";
import { EXPLANATION_MAX, EXPLANATION_MIN } from "@/lib/finance/insurance-receivable-control";

import {
  buildClosePackAction,
  explainInsReceivable,
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
  certificate = null,
}: {
  who: "finance" | "ceo";
  id: string;
  month: string;
  hash: string;
  /** Phase 22C: the signer's own certificate, when they have one. */
  certificate?: { label: string; usable: boolean } | null;
}) {
  const run = who === "finance" ? signOffFinance : signOffCeo;
  return (
    <ActionForm
      submitLabel={who === "finance" ? "Sign for Finance" : "Sign as CEO and lock the month"}
      action={async (v) => run({ id, month, hash, note: v.note ?? "", pin: v.pin ?? "" })}
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
      {certificate && (
        <Field
          label="Sign with my certificate (optional)"
          hint={
            certificate.usable
              ? `Type the PIN of ${certificate.label} to add your personal digital signature. Leave blank to sign off without it.`
              : "Your certificate is not valid now; replace it under Settings, Signing certificate."
          }
        >
          <Input
            name="pin"
            type="password"
            autoComplete="off"
            placeholder="Certificate PIN"
            maxLength={200}
            disabled={!certificate.usable}
          />
        </Field>
      )}
    </ActionForm>
  );
}

/** docs/48: the preparer's explanation of an insurance receivable difference (needed before the finance sign-off). */
export function ExplainInsReceivableForm({
  id,
  month,
  hash,
  current,
}: {
  id: string;
  month: string;
  hash: string;
  current: string | null;
}) {
  return (
    <ActionForm
      submitLabel={current ? "Update the explanation" : "Save the explanation"}
      variant="outline"
      action={async (v) => explainInsReceivable({ id, month, hash, note: v.note ?? "" })}
    >
      <Field
        label="Why does the Diligence receivable differ from Tally?"
        hint={`${EXPLANATION_MIN} to ${EXPLANATION_MAX} characters. Amounts, payer ids and reasons only; no patient details. A different person reviews it when they sign for Finance.`}
      >
        <Textarea
          name="note"
          rows={3}
          minLength={EXPLANATION_MIN}
          maxLength={EXPLANATION_MAX}
          defaultValue={current ?? ""}
        />
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
