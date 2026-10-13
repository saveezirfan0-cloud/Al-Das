"use client";

import * as React from "react";
import { Copy, Download } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ActionForm, Field, RunButton, selectClass } from "@/components/finance/forms";
import {
  canMoveCase,
  nextCaseStatuses,
  STATUS_LABELS,
  type CaseStatus,
} from "@/lib/finance/denials";

import {
  addDenialNote,
  assignDenialCase,
  createAppealDraft,
  discardAppealDraft,
  markAppealSent,
  setDenialStatus,
  syncDenialCases,
} from "./actions";

export function SyncButton() {
  return <RunButton action={syncDenialCases}>Refresh from claims</RunButton>;
}

export function AssignControl({
  id,
  owner,
  people,
}: {
  id: string;
  owner: string | null;
  people: Array<{ id: string; name: string }>;
}) {
  return (
    <ActionForm
      className="flex-row items-end gap-2"
      submitLabel="Assign"
      variant="secondary"
      action={async (v) => assignDenialCase({ id, owner: v.owner ?? "" })}
    >
      <Field label="Owner">
        <select name="owner" className={selectClass} defaultValue={owner ?? ""}>
          <option value="">Unassigned</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
    </ActionForm>
  );
}

export function StatusControl({ id, status }: { id: string; status: CaseStatus }) {
  const moves = nextCaseStatuses(status);
  const [to, setTo] = React.useState<CaseStatus | "">("");
  if (moves.length === 0)
    return <p className="text-muted-foreground text-sm">This case is closed.</p>;
  const closing = to !== "" && !["open", "in_progress", "appealed", "resubmitted"].includes(to);
  return (
    <ActionForm
      submitLabel="Update status"
      variant="secondary"
      action={async (v) => setDenialStatus({ id, to: v.to ?? "", note: v.note ?? "" })}
    >
      <Field label="Move to">
        <select
          name="to"
          className={selectClass}
          value={to}
          onChange={(e) => setTo(e.target.value as CaseStatus)}
          required
        >
          <option value="">Choose…</option>
          {moves
            .filter((m) => canMoveCase(status, m))
            .map((m) => (
              <option key={m} value={m}>
                {STATUS_LABELS[m]}
              </option>
            ))}
        </select>
      </Field>
      {closing && (
        <Field label="Reason (required to close)" hint="Short, no clinical detail.">
          <Input name="note" required minLength={3} maxLength={200} />
        </Field>
      )}
    </ActionForm>
  );
}

export function NoteForm({ id }: { id: string }) {
  const [key, setKey] = React.useState(0);
  return (
    <ActionForm
      key={key}
      submitLabel="Add note"
      variant="secondary"
      onDone={() => setKey((k) => k + 1)}
      action={async (v) => addDenialNote({ id, note: v.note ?? "" })}
    >
      <Field label="Working note" hint="For the team. Avoid patient names and clinical detail.">
        <Textarea name="note" rows={3} maxLength={2000} required />
      </Field>
    </ActionForm>
  );
}

export function AppealPanel({
  id,
  aiEnabled,
  appealable,
}: {
  id: string;
  aiEnabled: boolean;
  appealable: boolean;
}) {
  const [language, setLanguage] = React.useState("en");
  return (
    <div className="flex flex-col gap-3">
      {!appealable && (
        <p className="text-sm text-amber-600 dark:text-amber-400">
          The taxonomy marks this denial code as normally not appealable (for example a duplicate or
          a late submission). A letter can still be drafted.
        </p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <RunButton variant="outline" action={() => createAppealDraft({ id, mode: "template" })}>
          Standard template
        </RunButton>
        <RunButton variant="outline" action={() => createAppealDraft({ id, mode: "ai", language })}>
          Draft with AI
        </RunButton>
        <select
          aria-label="Language of the AI draft"
          className={selectClass + " w-auto"}
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        >
          <option value="en">English</option>
          <option value="ar">Arabic</option>
        </select>
      </div>
      <p className="text-muted-foreground text-xs">
        {aiEnabled
          ? "AI sees only the claim and invoice numbers, the denial code, amounts and dates: never a patient's name or clinical detail. Every draft is marked DRAFT and nothing is sent from Pulse."
          : "AI is switched off for this workspace, so “Draft with AI” will explain how to turn it on. The standard template always works. Nothing is ever sent from Pulse."}
      </p>
    </div>
  );
}

export type DraftView = {
  id: string;
  kind: string;
  language: string;
  body: string;
  flags: string[];
  status: string;
  created_at: string;
  author: string;
  model: string | null;
};

export function DraftCard({ draft }: { draft: DraftView }) {
  const live = draft.status === "draft";
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="warning">DRAFT</Badge>
        <Badge variant="outline">{draft.kind === "ai" ? "AI" : "Template"}</Badge>
        {draft.status !== "draft" && (
          <Badge variant="secondary">
            {draft.status === "marked_sent" ? "Sent by hand" : "Discarded"}
          </Badge>
        )}
        <span className="text-muted-foreground">
          {draft.author},{" "}
          {new Date(draft.created_at).toLocaleString("en-GB", {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </span>
      </div>
      {draft.flags.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-amber-600 dark:text-amber-400">
          {draft.flags.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      <pre
        dir={draft.language === "ar" ? "rtl" : "ltr"}
        className="bg-muted/40 max-h-96 overflow-auto rounded p-3 text-xs whitespace-pre-wrap"
      >
        {draft.body}
      </pre>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={async () => {
            await navigator.clipboard.writeText(draft.body);
            toast.success(
              "Copied. Paste it into the payer's portal or an e-mail you send yourself.",
            );
          }}
        >
          <Copy /> Copy
        </Button>
        <Button asChild size="sm" variant="outline">
          <a
            download={`appeal-draft-${draft.id.slice(0, 8)}.txt`}
            href={`data:text/plain;charset=utf-8,${encodeURIComponent(draft.body)}`}
          >
            <Download /> Download
          </a>
        </Button>
        {live && (
          <RunButton
            confirm="Record that you sent this letter yourself?"
            action={() => markAppealSent(draft.id)}
          >
            I sent it myself
          </RunButton>
        )}
        {live && (
          <RunButton
            variant="ghost"
            confirm="Discard this draft?"
            action={() => discardAppealDraft(draft.id)}
          >
            Discard
          </RunButton>
        )}
      </div>
    </div>
  );
}
