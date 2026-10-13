"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { ActionForm, Field, selectClass } from "@/components/finance/forms";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { FOLLOWUP_NOTE_MAX, FOLLOWUP_OUTCOMES, OUTCOME_LABELS } from "@/lib/finance/followup";

import { addFollowup } from "./actions";

/** The claim drawer (house style: records open in a right-hand drawer). Closing it returns to the list with its filters. */
export function ClaimDrawer({
  title,
  description,
  closeHref,
  children,
}: {
  title: string;
  description?: string;
  closeHref: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(true);
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) router.push(closeHref, { scroll: false });
      }}
    >
      <SheetContent className="overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        <div className="flex flex-col gap-6 px-4 pb-6">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

export function FollowupForm({ claimId, minDate }: { claimId: string; minDate: string }) {
  const router = useRouter();
  const [key, setKey] = React.useState(0);
  return (
    <ActionForm
      key={key}
      action={(v) => addFollowup({ ...v, claim_id: claimId })}
      submitLabel="Save follow-up"
      onDone={() => {
        setKey((k) => k + 1);
        router.refresh();
      }}
    >
      <Field label="Outcome">
        <select name="outcome" className={selectClass} defaultValue="contacted">
          {FOLLOWUP_OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {OUTCOME_LABELS[o]}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="Note"
        hint="What was agreed and with whom at the payer. No patient names, card or phone numbers."
      >
        <Textarea name="note" maxLength={FOLLOWUP_NOTE_MAX} rows={3} />
      </Field>
      <Field label="Next action on" hint="Leave blank if nothing more is planned.">
        <Input name="next_action_date" type="date" min={minDate} />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="close_task" defaultChecked /> Close this claim&apos;s open
        follow-up task
      </label>
    </ActionForm>
  );
}
