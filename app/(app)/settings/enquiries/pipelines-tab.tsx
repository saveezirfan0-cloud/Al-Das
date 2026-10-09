"use client";

import * as React from "react";
import { Archive, ArchiveRestore, Loader2, Plus, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { OptionSelect } from "@/app/(app)/enquiries/option-select";
import { SortableItem, SortableList } from "@/components/sortable/sortable-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { tagClass } from "@/lib/contacts/format";
import { STAGE_COLORS } from "@/lib/enquiries/constants";
import type { PipelineInfo, StageInfo } from "@/lib/enquiries/server";

import {
  addStageAction,
  createPipelineAction,
  deletePipelineAction,
  deleteStageAction,
  reorderStagesAction,
  updatePipelineAction,
  updateStageAction,
} from "./actions";

const SLA_CHOICES = [5, 10, 15, 30, 60, 120, 240, 480, 1440];

export function PipelinesTab({
  pipelines,
  stageCounts,
}: {
  pipelines: PipelineInfo[];
  stageCounts: Record<string, number>;
}) {
  const [newOpen, setNewOpen] = React.useState(false);
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-muted-foreground text-sm">
          Each pipeline is a board of stages. Model the clinic&apos;s queues as pipelines:
          reception, doctor liaison, insurance review…
        </p>
        <Button onClick={() => setNewOpen(true)}>
          <Plus /> New pipeline
        </Button>
      </div>
      {pipelines.length === 0 && (
        <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">
          No pipelines yet. Create one to start taking enquiries.
        </p>
      )}
      {pipelines.map((p) => (
        <PipelineCard key={p.id} pipeline={p} stageCounts={stageCounts} />
      ))}
      <NewPipelineDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  );
}

function NewPipelineDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [name, setName] = React.useState("");
  const [pending, startTransition] = React.useTransition();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New pipeline</DialogTitle>
          <DialogDescription>
            It starts with three stages (New, In progress, Booked) that you can rename, reorder or
            replace.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              const res = await createPipelineAction({ name });
              if (!res.ok) return void toast.error(res.error);
              toast.success(res.message ?? "Created.");
              setName("");
              onOpenChange(false);
            });
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="np-name">Name</Label>
            <Input
              id="np-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              required
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending && <Loader2 className="animate-spin" />} Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PipelineCard({
  pipeline: p,
  stageCounts,
}: {
  pipeline: PipelineInfo;
  stageCounts: Record<string, number>;
}) {
  const [name, setName] = React.useState(p.name);
  const [stages, setStages] = React.useState<StageInfo[]>(p.stages);
  const [newStage, setNewStage] = React.useState("");
  const [removing, setRemoving] = React.useState<StageInfo | null>(null);
  const [pending, startTransition] = React.useTransition();
  React.useEffect(() => setName(p.name), [p.name]);
  React.useEffect(() => setStages(p.stages), [p.stages]);

  function run(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) toast.error(res.error);
      else if (res.message) toast.success(res.message);
    });
  }

  return (
    <Card className={p.archived ? "opacity-70" : undefined}>
      <CardHeader className="flex flex-row flex-wrap items-center gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Input
            aria-label="Pipeline name"
            value={name}
            maxLength={80}
            className="h-8 w-56"
            onChange={(e) => setName(e.target.value)}
            onBlur={() =>
              name.trim() && name !== p.name && run(() => updatePipelineAction(p.id, { name }))
            }
          />
          {p.is_default && <Badge variant="secondary">Default</Badge>}
          {p.archived && <Badge variant="outline">Archived</Badge>}
        </CardTitle>
        <div className="ml-auto flex items-center gap-2">
          <div className="w-44">
            <OptionSelect
              noneLabel="Org default SLA"
              value={p.sla_minutes === null ? null : String(p.sla_minutes)}
              options={SLA_CHOICES.map((m) => ({
                value: String(m),
                label: `SLA ${m < 60 ? `${m} min` : m < 1440 ? `${m / 60} h` : "1 day"}`,
              }))}
              onChange={(v) =>
                run(() => updatePipelineAction(p.id, { slaMinutes: v === null ? null : Number(v) }))
              }
            />
          </div>
          {!p.is_default && !p.archived && (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => run(() => updatePipelineAction(p.id, { makeDefault: true }))}
            >
              <Star /> Make default
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => run(() => updatePipelineAction(p.id, { archived: !p.archived }))}
          >
            {p.archived ? <ArchiveRestore /> : <Archive />} {p.archived ? "Restore" : "Archive"}
          </Button>
          {!p.is_default && (
            <Button
              variant="ghost"
              size="icon"
              className="text-destructive"
              aria-label={`Delete ${p.name}`}
              disabled={pending}
              onClick={() =>
                confirm(
                  `Delete the pipeline “${p.name}”? This only works if it never held an enquiry.`,
                ) && run(() => deletePipelineAction(p.id))
              }
            >
              <Trash2 />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <SortableList
          ids={stages.map((s) => s.id)}
          onReorder={(ids) => {
            const prev = stages;
            setStages(ids.map((id) => stages.find((s) => s.id === id)!));
            startTransition(async () => {
              const res = await reorderStagesAction(p.id, ids);
              if (!res.ok) {
                toast.error(res.error);
                setStages(prev);
              }
            });
          }}
        >
          {stages.map((s) => (
            <SortableItem key={s.id} id={s.id} handleLabel={`Drag stage ${s.name}`}>
              <StageRow
                stage={s}
                count={stageCounts[s.id] ?? 0}
                onRemove={() => setRemoving(s)}
                onChanged={(patch) =>
                  setStages((cur) => cur.map((x) => (x.id === s.id ? { ...x, ...patch } : x)))
                }
              />
            </SortableItem>
          ))}
        </SortableList>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newStage.trim()) return;
            run(async () => {
              const res = await addStageAction(p.id, { name: newStage.trim() });
              if (res.ok) setNewStage("");
              return res;
            });
          }}
        >
          <Input
            value={newStage}
            onChange={(e) => setNewStage(e.target.value)}
            maxLength={80}
            placeholder="New stage name"
            aria-label={`New stage in ${p.name}`}
            className="max-w-xs"
          />
          <Button type="submit" variant="outline" disabled={pending || !newStage.trim()}>
            <Plus /> Add stage
          </Button>
        </form>
      </CardContent>
      <RemoveStageDialog
        stage={removing}
        siblings={stages}
        count={removing ? (stageCounts[removing.id] ?? 0) : 0}
        onClose={() => setRemoving(null)}
      />
    </Card>
  );
}

function StageRow({
  stage,
  count,
  onRemove,
  onChanged,
}: {
  stage: StageInfo;
  count: number;
  onRemove: () => void;
  onChanged: (p: Partial<StageInfo>) => void;
}) {
  const [name, setName] = React.useState(stage.name);
  React.useEffect(() => setName(stage.name), [stage.name]);
  return (
    <div className="bg-muted/30 flex flex-1 items-center gap-2 rounded-lg border px-2 py-1.5">
      <Input
        aria-label="Stage name"
        value={name}
        maxLength={80}
        className="h-8 flex-1"
        onChange={(e) => setName(e.target.value)}
        onBlur={async () => {
          if (!name.trim() || name === stage.name) return;
          const res = await updateStageAction(stage.id, { name });
          if (res.ok) onChanged({ name });
          else {
            toast.error(res.error);
            setName(stage.name);
          }
        }}
      />
      <div className="flex items-center gap-1" role="group" aria-label="Colour">
        {STAGE_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={c}
            aria-pressed={stage.color === c}
            className={`size-5 rounded-full border-2 ${tagClass(c)} ${stage.color === c ? "border-foreground" : "border-transparent"}`}
            onClick={async () => {
              const res = await updateStageAction(stage.id, { color: c });
              if (res.ok) onChanged({ color: c });
              else toast.error(res.error);
            }}
          />
        ))}
      </div>
      <span className="text-muted-foreground w-24 text-right text-xs tabular-nums">
        {count.toLocaleString()} enquiries
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="text-destructive size-8"
        aria-label={`Delete stage ${stage.name}`}
        onClick={onRemove}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

function RemoveStageDialog({
  stage,
  siblings,
  count,
  onClose,
}: {
  stage: StageInfo | null;
  siblings: StageInfo[];
  count: number;
  onClose: () => void;
}) {
  const [target, setTarget] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  React.useEffect(() => setTarget(null), [stage?.id]);
  if (!stage) return null;
  const others = siblings.filter((s) => s.id !== stage.id);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete the stage “{stage.name}”?</DialogTitle>
          <DialogDescription>
            {count > 0
              ? `${count.toLocaleString()} enquir${count === 1 ? "y is" : "ies are"} in this stage. Choose where they go.`
              : "No enquiries are in this stage."}
          </DialogDescription>
        </DialogHeader>
        {count > 0 && (
          <div className="grid gap-1.5">
            <Label htmlFor="move-target">Move them to</Label>
            <OptionSelect
              id="move-target"
              allowNone={false}
              placeholder="Choose a stage"
              value={target}
              options={others.map((s) => ({ value: s.id, label: s.name }))}
              onChange={setTarget}
            />
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={pending || (count > 0 && !target)}
            onClick={() =>
              startTransition(async () => {
                const res = await deleteStageAction(stage.id, target);
                if (!res.ok) return void toast.error(res.error);
                toast.success(res.message ?? "Deleted.");
                onClose();
              })
            }
          >
            {pending && <Loader2 className="animate-spin" />} Delete stage
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
