"use client";

import { useRouter } from "next/navigation";

import { ActionForm, Field, FormSheet, RunButton } from "@/components/finance/forms";
import { Input } from "@/components/ui/input";

import { journalStep, postJournal, reverseJournal } from "./actions";

/** The buttons on a journal's page. Each server action checks the permission again; the database decides the rest. */

export function SubmitJournal({ id }: { id: string }) {
  const router = useRouter();
  return (
    <RunButton
      variant="default"
      action={() => journalStep({ id, action: "submit" })}
      onDone={() => router.refresh()}
    >
      Submit for posting
    </RunButton>
  );
}

export function DiscardJournal({ id }: { id: string }) {
  const router = useRouter();
  return (
    <RunButton
      variant="ghost"
      confirm="Delete this draft? This cannot be undone."
      action={() => journalStep({ id, action: "discard" })}
      onDone={() => router.push("/accounting/journals")}
    >
      Delete draft
    </RunButton>
  );
}

export function PostJournal({ id, hash, number }: { id: string; hash: string; number?: string }) {
  const router = useRouter();
  return (
    <RunButton
      variant="default"
      confirm={`Post this journal${number ? ` ${number}` : ""}? A posted journal never changes; it can only be reversed.`}
      action={() => postJournal({ id, hash })}
      onDone={() => router.refresh()}
    >
      Post
    </RunButton>
  );
}

export function ReturnJournal({ id }: { id: string }) {
  const router = useRouter();
  return (
    <FormSheet trigger="Send back" title="Send the journal back" variant="outline" size="sm">
      {(close) => (
        <ActionForm
          action={(v) => journalStep({ id, action: "return", remarks: v.remarks ?? "" })}
          submitLabel="Send back"
          onDone={() => {
            close();
            router.refresh();
          }}
        >
          <Field label="Reason" hint="The maker sees it on the journal.">
            <Input name="remarks" minLength={3} maxLength={500} required />
          </Field>
        </ActionForm>
      )}
    </FormSheet>
  );
}

export function ReverseJournal({ id, defaultDate }: { id: string; defaultDate: string }) {
  const router = useRouter();
  return (
    <FormSheet
      trigger="Reverse"
      title="Reverse this journal"
      description="Posts the mirror journal (debits and credits swapped) on the date you choose and links the two. The original stays in the ledger."
      variant="outline"
      size="sm"
    >
      {(close) => (
        <ActionForm
          action={async (v) => {
            const res = await reverseJournal({ id, date: v.date ?? "", reason: v.reason ?? "" });
            if (res.ok && res.data) router.push(`/accounting/journals/${res.data.id}`);
            return res;
          }}
          submitLabel="Reverse"
          variant="destructive"
          onDone={() => {
            close();
            router.refresh();
          }}
        >
          <Field label="Reversal date" hint="On or after the journal's date, in an open period.">
            <Input type="date" name="date" defaultValue={defaultDate} required />
          </Field>
          <Field label="Reason">
            <Input name="reason" minLength={3} maxLength={200} required />
          </Field>
        </ActionForm>
      )}
    </FormSheet>
  );
}
