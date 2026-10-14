"use client";

import * as React from "react";
import { ListChecks, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { OptionSelect } from "@/app/(app)/enquiries/option-select";
import { RecordHistorySection } from "@/components/history/record-history";
import { useConfirm } from "@/components/shell/confirm-dialog";
import { EmptyState } from "@/components/shell/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  CHECKLIST_KINDS,
  CHECKLIST_KIND_LABELS,
  parseChecklistLines,
  type ChecklistKind,
} from "@/lib/tasks/checklist";

import {
  deleteChecklistTemplate,
  listChecklistTemplates,
  saveChecklistTemplate,
  type ChecklistTemplateRow,
} from "./parts-actions";
import type { TasksBootstrap } from "./types";

type Draft = {
  id: string | null;
  location_id: string | null;
  name: string;
  kind: ChecklistKind;
  lines: string;
  generate_at: string;
  due_time: string;
  assignee_id: string | null;
  team_id: string | null;
  active: boolean;
};

const blank = (branch: string | null): Draft => ({
  id: null,
  location_id: branch,
  name: "Opening checklist",
  kind: "opening",
  lines: "",
  generate_at: "06:00",
  due_time: "09:00",
  assignee_id: null,
  team_id: null,
  active: true,
});

/**
 * Daily opening / closing checklists per branch (Phase F). Each active one becomes a task with its items every morning
 * at the branch (Tasks, Checklists); administrators edit them here.
 */
export function ChecklistTemplatesDialog({
  open,
  onOpenChange,
  bootstrap,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  bootstrap: TasksBootstrap;
}) {
  const [rows, setRows] = React.useState<ChecklistTemplateRow[] | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [pending, startTransition] = React.useTransition();
  const [confirm, confirmDialog] = useConfirm();
  const canEdit = bootstrap.can.settings;

  const load = React.useCallback(async () => {
    const r = await listChecklistTemplates();
    if (r.ok) setRows(r.data);
    else toast.error(r.error);
  }, []);

  React.useEffect(() => {
    if (open) {
      setDraft(null);
      void load();
    }
  }, [open, load]);

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const lineCount = draft ? parseChecklistLines(draft.lines).length : 0;

  function save() {
    if (!draft?.location_id) return void toast.error("Choose the branch.");
    startTransition(async () => {
      const r = await saveChecklistTemplate({ ...draft, location_id: draft.location_id! });
      if (!r.ok) return void toast.error(r.error);
      toast.success(r.message ?? "Saved.");
      setDraft(null);
      await load();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Daily checklists</DialogTitle>
          <DialogDescription>
            Each branch&apos;s opening and closing list becomes one task every morning, with the
            items to tick off.
          </DialogDescription>
        </DialogHeader>
        {draft ? (
          <div className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="cl-name">Name</Label>
                <Input
                  id="cl-name"
                  maxLength={120}
                  value={draft.name}
                  onChange={(e) => set({ name: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="cl-branch">Branch</Label>
                <OptionSelect
                  id="cl-branch"
                  allowNone={false}
                  placeholder="Choose a branch"
                  value={draft.location_id}
                  options={bootstrap.branches.map((b) => ({ value: b.id, label: b.name }))}
                  onChange={(v) => set({ location_id: v })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="cl-kind">Kind</Label>
                <OptionSelect
                  id="cl-kind"
                  allowNone={false}
                  value={draft.kind}
                  options={CHECKLIST_KINDS.map((k) => ({
                    value: k,
                    label: CHECKLIST_KIND_LABELS[k],
                  }))}
                  onChange={(v) => set({ kind: (v ?? "opening") as ChecklistKind })}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="cl-gen">Made at</Label>
                  <Input
                    id="cl-gen"
                    type="time"
                    value={draft.generate_at}
                    onChange={(e) => set({ generate_at: e.target.value })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="cl-due">Due at</Label>
                  <Input
                    id="cl-due"
                    type="time"
                    value={draft.due_time}
                    onChange={(e) => set({ due_time: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="cl-assignee">Assigned to</Label>
                <OptionSelect
                  id="cl-assignee"
                  noneLabel="Nobody (the team or the branch)"
                  value={draft.assignee_id}
                  options={bootstrap.users.map((u) => ({ value: u.id, label: u.label }))}
                  onChange={(v) => set({ assignee_id: v })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="cl-team">Team</Label>
                <OptionSelect
                  id="cl-team"
                  noneLabel="No team"
                  value={draft.team_id}
                  options={bootstrap.teams.map((t) => ({ value: t.id, label: t.name }))}
                  onChange={(v) => set({ team_id: v })}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="cl-lines">Items, one per line ({lineCount} of 50)</Label>
              <Textarea
                id="cl-lines"
                rows={8}
                value={draft.lines}
                placeholder={
                  "Switch on the lights and air conditioning\nCheck the fridge temperature\nCount the cash float"
                }
                onChange={(e) => set({ lines: e.target.value })}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.active}
                onCheckedChange={(c) => set({ active: c === true })}
              />{" "}
              Make it every day
            </label>
            {draft.id && (
              <RecordHistorySection table="task_checklist_templates" recordId={draft.id} />
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Back
              </Button>
              <Button onClick={save} disabled={pending || !draft.name.trim() || lineCount === 0}>
                {pending && <Loader2 className="animate-spin" />} Save checklist
              </Button>
            </div>
          </div>
        ) : rows === null ? (
          <Loader2 className="text-muted-foreground size-4 animate-spin" />
        ) : (
          <div className="grid gap-3">
            {rows.length === 0 ? (
              <EmptyState
                icon={ListChecks}
                title="No daily checklists yet"
                description="Add an opening and a closing list for each branch; Pulse makes the day's task every morning."
              />
            ) : (
              <ul className="divide-y rounded-lg border text-sm">
                {rows.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 px-3 py-2">
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{t.name}</span>{" "}
                      <span className="text-muted-foreground text-xs">
                        {bootstrap.branchNames[t.location_id] ?? "Branch"} · {t.items.length} items
                        · made {t.generate_at}, due {t.due_time}
                      </span>
                    </span>
                    <Badge variant={t.active ? "success" : "outline"}>
                      {t.active ? "On" : "Off"}
                    </Badge>
                    {canEdit && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Edit ${t.name}`}
                          onClick={() =>
                            setDraft({
                              id: t.id,
                              location_id: t.location_id,
                              name: t.name,
                              kind: (t.kind as ChecklistKind) ?? "other",
                              lines: t.items.join("\n"),
                              generate_at: t.generate_at,
                              due_time: t.due_time,
                              assignee_id: t.assignee_id,
                              team_id: t.team_id,
                              active: t.active,
                            })
                          }
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-destructive"
                          aria-label={`Delete ${t.name}`}
                          onClick={async () => {
                            const ok = await confirm({
                              title: `Delete “${t.name}”?`,
                              description:
                                "No new lists are made from it. Lists already made stay with their tasks.",
                              confirmLabel: "Delete",
                              destructive: true,
                            });
                            if (!ok) return;
                            const r = await deleteChecklistTemplate(t.id);
                            if (r.ok) {
                              toast.success(r.message ?? "Deleted.");
                              await load();
                            } else toast.error(r.error);
                          }}
                        >
                          <Trash2 />
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canEdit ? (
              <Button
                variant="outline"
                className="justify-self-start"
                disabled={bootstrap.branches.length === 0}
                onClick={() =>
                  setDraft(blank(bootstrap.currentBranch ?? bootstrap.branches[0]?.id ?? null))
                }
              >
                <Plus /> New checklist
              </Button>
            ) : (
              <p className="text-muted-foreground text-xs">Administrators edit these lists.</p>
            )}
          </div>
        )}
        {confirmDialog}
      </DialogContent>
    </Dialog>
  );
}
