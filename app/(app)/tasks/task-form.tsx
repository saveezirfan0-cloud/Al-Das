"use client";

import { useEffect, useState } from "react";
import { Search, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { TASK_TYPE_LABELS, TASK_TYPES, type TaskType } from "@/lib/tasks/due";
import type { TaskRow } from "@/lib/tasks/types";

import { formatPhone } from "@/lib/phone";
import { fromLocalInput, toLocalInput } from "../enquiries/format";
import { enquiryByNumber, searchPatients, type PatientOption } from "./actions";

const NONE = "__none";

export type TaskDraft = {
  type: TaskType;
  subject: string;
  notes: string;
  due: string; // datetime-local in the org timezone
  assignee_id: string;
  patient: { id: string; name: string } | null;
  enquiry: { id: string; number: number } | null;
};

export function emptyDraft(over: Partial<TaskDraft> = {}): TaskDraft {
  return {
    type: "todo",
    subject: "",
    notes: "",
    due: "",
    assignee_id: NONE,
    patient: null,
    enquiry: null,
    ...over,
  };
}

export function draftFromTask(t: TaskRow, tz: string): TaskDraft {
  return {
    type: t.type,
    subject: t.subject,
    notes: t.notes ?? "",
    due: toLocalInput(t.due_at, tz),
    assignee_id: t.assignee_id ?? NONE,
    patient: t.contact_id ? { id: t.contact_id, name: t.patient } : null,
    enquiry:
      t.enquiry_id && t.enquiry_number !== null
        ? { id: t.enquiry_id, number: t.enquiry_number }
        : null,
  };
}

/** The server input for a draft. */
export function draftToInput(d: TaskDraft, tz: string) {
  return {
    type: d.type,
    subject: d.subject.trim(),
    notes: d.notes.trim() || null,
    due_at: fromLocalInput(d.due, tz),
    assignee_id: d.assignee_id === NONE ? null : d.assignee_id,
    contact_id: d.patient?.id ?? null,
    enquiry_id: d.enquiry?.id ?? null,
  };
}

/** Fields shared by the task drawer and the quick-add in the enquiry drawer. */
export function TaskFields({
  draft,
  onChange,
  users,
  timezone,
  lockLinks,
  canSearchPatients,
  canLookUpEnquiries,
  compact,
}: {
  draft: TaskDraft;
  onChange: (d: TaskDraft) => void;
  users: Array<{ id: string; label: string }>;
  timezone: string;
  /** Hide the patient / enquiry pickers (the task is already attached to a record). */
  lockLinks?: boolean;
  canSearchPatients: boolean;
  canLookUpEnquiries: boolean;
  compact?: boolean;
}) {
  const set = <K extends keyof TaskDraft>(k: K, v: TaskDraft[K]) => onChange({ ...draft, [k]: v });
  const [term, setTerm] = useState("");
  const [found, setFound] = useState<PatientOption[]>([]);
  const [enqText, setEnqText] = useState(draft.enquiry ? `#${draft.enquiry.number}` : "");
  const [enqError, setEnqError] = useState<string | null>(null);

  useEffect(() => {
    if (draft.patient || term.trim().length < 2) {
      setFound([]);
      return;
    }
    const handle = setTimeout(async () => {
      const r = await searchPatients(term);
      setFound(r.ok ? r.patients : []);
    }, 250);
    return () => clearTimeout(handle);
  }, [term, draft.patient]);

  async function resolveEnquiry(text: string) {
    setEnqError(null);
    const n = Number(text.replace(/\D/g, ""));
    if (!text.trim()) {
      set("enquiry", null);
      return;
    }
    const r = await enquiryByNumber(n);
    if (!r.ok) setEnqError(r.error);
    else if (!r.enquiry) setEnqError("No enquiry with that number.");
    else onChange({ ...draft, enquiry: { id: r.enquiry.id, number: r.enquiry.number } });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="task-subject">Subject</Label>
        <Input
          id="task-subject"
          value={draft.subject}
          maxLength={200}
          onChange={(e) => set("subject", e.target.value)}
          placeholder="What needs doing?"
        />
      </div>
      <div className={compact ? "grid grid-cols-2 gap-3" : "grid gap-3 sm:grid-cols-2"}>
        <div className="flex flex-col gap-1.5">
          <Label>Type</Label>
          <Select value={draft.type} onValueChange={(v) => set("type", v as TaskType)}>
            <SelectTrigger className="w-full" aria-label="Task type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TASK_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {TASK_TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Assigned to</Label>
          <Select value={draft.assignee_id} onValueChange={(v) => set("assignee_id", v)}>
            <SelectTrigger className="w-full" aria-label="Assigned to">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Unassigned</SelectItem>
              {users.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="task-due">Due ({timezone})</Label>
          <Input
            id="task-due"
            type="datetime-local"
            value={draft.due}
            onChange={(e) => set("due", e.target.value)}
          />
        </div>
      </div>

      {!lockLinks && (
        <div className="grid gap-3 sm:grid-cols-2">
          {canSearchPatients && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="task-patient">Patient</Label>
              {draft.patient ? (
                <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                  <span>{draft.patient.name || "Unnamed contact"}</span>
                  <button
                    type="button"
                    aria-label="Remove patient"
                    onClick={() => set("patient", null)}
                  >
                    <X className="size-4" />
                  </button>
                </div>
              ) : (
                <>
                  <div className="relative">
                    <Search
                      className="text-muted-foreground pointer-events-none absolute start-2 top-1/2 size-4 -translate-y-1/2"
                      aria-hidden
                    />
                    <Input
                      id="task-patient"
                      className="ps-8"
                      placeholder="Search name or phone"
                      value={term}
                      onChange={(e) => setTerm(e.target.value)}
                      autoComplete="off"
                    />
                  </div>
                  {found.length > 0 && (
                    <ul
                      className="max-h-36 overflow-y-auto rounded-md border"
                      role="listbox"
                      aria-label="Matching patients"
                    >
                      {found.map((p) => (
                        <li key={p.id}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={false}
                            className="hover:bg-accent flex w-full items-center justify-between px-3 py-1.5 text-start text-sm"
                            onClick={() => {
                              set("patient", { id: p.id, name: p.name });
                              setTerm("");
                            }}
                          >
                            <span>{p.name || "Unnamed contact"}</span>
                            {p.phone && (
                              <span className="text-muted-foreground tabular-nums">
                                {formatPhone(p.phone)}
                              </span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          )}
          {canLookUpEnquiries && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="task-enq">Enquiry number</Label>
              <Input
                id="task-enq"
                value={enqText}
                placeholder="#123 (optional)"
                inputMode="numeric"
                onChange={(e) => {
                  setEnqText(e.target.value);
                  if (draft.enquiry) set("enquiry", null);
                }}
                onBlur={() => void resolveEnquiry(enqText)}
              />
              {enqError && <p className="text-destructive text-xs">{enqError}</p>}
              {draft.enquiry && (
                <p className="text-muted-foreground text-xs">
                  Linked to enquiry #{draft.enquiry.number}.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="task-notes">Notes</Label>
        <Textarea
          id="task-notes"
          rows={compact ? 2 : 4}
          value={draft.notes}
          maxLength={4000}
          onChange={(e) => set("notes", e.target.value)}
        />
      </div>
    </div>
  );
}
