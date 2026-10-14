"use client";

import { useRouter } from "next/navigation";

import { ActionForm, Field, RunButton } from "@/components/finance/forms";
import { Input } from "@/components/ui/input";

import { postRunAction, prepareRunAction } from "./actions";

/** Prepare a month's run (a draft to review) and post one. The server actions and SQL check everything again. */

export function PrepareRunForm({
  kind,
  defaultMonth,
  label = "Prepare",
}: {
  kind: "depreciation" | "schedules" | "reversing_accruals";
  defaultMonth: string;
  label?: string;
}) {
  const router = useRouter();
  return (
    <ActionForm
      action={(v) => prepareRunAction({ ...v, kind })}
      submitLabel={label}
      variant="secondary"
      className="flex-row flex-wrap items-end"
      onDone={() => router.refresh()}
    >
      <Field label="Month">
        <Input type="month" name="month" defaultValue={defaultMonth} className="w-44" required />
      </Field>
    </ActionForm>
  );
}

export function PostRunButton({ id, hash, label }: { id: string; hash: string; label: string }) {
  const router = useRouter();
  return (
    <RunButton
      variant="default"
      confirm={`Post ${label}? It becomes a journal in the ledger; a later change is posted as a new version that reverses this one.`}
      action={() => postRunAction({ id, hash })}
      onDone={() => router.refresh()}
    >
      Post
    </RunButton>
  );
}
