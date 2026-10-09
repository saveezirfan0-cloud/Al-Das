"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Archive, ArchiveRestore, GripVertical, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelect } from "@/components/ui/multi-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CARD_FIELDS } from "@/lib/enquiries/columns";
import { STAGE_COLORS } from "@/lib/enquiries/defaults";
import { moveById } from "@/lib/enquiries/ordering";
import type { PipelineView } from "@/lib/enquiries/types";

import { StageDot } from "../../enquiries/badges";
import {
  archivePipeline,
  createPipeline,
  createStage,
  deleteStage,
  reorderStages,
  updatePipeline,
  updateStage,
  type ActionResult,
} from "./actions";

type Team = { id: string; name: string };
const NONE = "__none";

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  function run(fn: () => Promise<ActionResult>, done?: string) {
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error);
      else {
        if (done) toast.success(done);
        router.refresh();
      }
    });
  }
  return { run, pending };
}

function StageRow({
  stage,
  disabled,
  onSave,
  onDelete,
}: {
  stage: PipelineView["stages"][number];
  disabled: boolean;
  onSave: (name: string, color: string) => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: stage.id,
  });
  const [name, setName] = useState(stage.name);
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`bg-background flex items-center gap-2 rounded-md border p-1.5 ${isDragging ? "opacity-60" : ""}`}
    >
      <button
        type="button"
        aria-label={`Reorder stage ${stage.name}`}
        className="text-muted-foreground cursor-grab touch-none p-1"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" />
      </button>
      <StageDot color={stage.color} />
      <Input
        aria-label={`Name of stage ${stage.name}`}
        className="h-8 flex-1"
        value={name}
        maxLength={80}
        disabled={disabled}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name.trim() !== stage.name && onSave(name.trim(), stage.color)}
        onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
      />
      <Select value={stage.color} disabled={disabled} onValueChange={(c) => onSave(stage.name, c)}>
        <SelectTrigger size="sm" className="w-28" aria-label={`Colour of stage ${stage.name}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {STAGE_COLORS.map((c) => (
            <SelectItem key={c} value={c}>
              <span className="flex items-center gap-2 capitalize">
                <StageDot color={c} /> {c}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Delete stage ${stage.name}`}
        disabled={disabled}
        onClick={onDelete}
      >
        <Trash2 />
      </Button>
    </li>
  );
}

function PipelineCard({ pipeline, teams }: { pipeline: PipelineView; teams: Team[] }) {
  const { run, pending } = useRun();
  const [name, setName] = useState(pipeline.name);
  const [team, setTeam] = useState(pipeline.default_team_id ?? NONE);
  const [fields, setFields] = useState<string[]>(pipeline.card_fields);
  const [stageName, setStageName] = useState("");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = pipeline.stages.map((s) => s.id);
  const dirty =
    name.trim() !== pipeline.name ||
    team !== (pipeline.default_team_id ?? NONE) ||
    JSON.stringify([...fields].sort()) !== JSON.stringify([...pipeline.card_fields].sort());

  function onDragEnd(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return;
    run(() => reorderStages(pipeline.id, moveById(ids, String(e.active.id), String(e.over!.id))));
  }

  return (
    <Card className={pipeline.archived ? "opacity-70" : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span>
            {pipeline.name}
            {pipeline.archived && (
              <span className="text-muted-foreground ms-2 text-xs font-normal">archived</span>
            )}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() =>
              run(
                () => archivePipeline(pipeline.id, !pipeline.archived),
                pipeline.archived ? "Restored." : "Archived.",
              )
            }
          >
            {pipeline.archived ? <ArchiveRestore /> : <Archive />}{" "}
            {pipeline.archived ? "Restore" : "Archive"}
          </Button>
        </CardTitle>
        <CardDescription>
          Stages, default team and the fields shown on its Kanban cards.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`pn-${pipeline.id}`}>Name</Label>
            <Input
              id={`pn-${pipeline.id}`}
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Default team</Label>
            <Select value={team} onValueChange={setTeam}>
              <SelectTrigger className="w-full" aria-label={`Default team for ${pipeline.name}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>None</SelectItem>
                {teams.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Card fields</Label>
            <MultiSelect
              options={CARD_FIELDS.map((f) => ({ value: f.key, label: f.label }))}
              value={fields}
              onChange={setFields}
              placeholder="None"
            />
          </div>
        </div>
        <div>
          <Button
            size="sm"
            disabled={!dirty || !name.trim() || pending}
            onClick={() =>
              run(
                () =>
                  updatePipeline(pipeline.id, {
                    name,
                    default_team_id: team === NONE ? null : team,
                    card_fields: fields,
                  }),
                "Pipeline saved.",
              )
            }
          >
            Save pipeline
          </Button>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Stages</h3>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              <ul className="flex flex-col gap-1.5">
                {pipeline.stages.map((s) => (
                  <StageRow
                    key={`${s.id}:${s.name}:${s.color}`}
                    stage={s}
                    disabled={pending}
                    onSave={(n, c) =>
                      run(() =>
                        updateStage(s.id, { name: n, color: c as (typeof STAGE_COLORS)[number] }),
                      )
                    }
                    onDelete={() => run(() => deleteStage(s.id), "Stage deleted.")}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!stageName.trim()) return;
              run(
                () => createStage(pipeline.id, { name: stageName, color: "slate" }),
                "Stage added.",
              );
              setStageName("");
            }}
          >
            <Input
              aria-label={`New stage name for ${pipeline.name}`}
              className="h-8"
              placeholder="New stage name"
              value={stageName}
              maxLength={80}
              onChange={(e) => setStageName(e.target.value)}
            />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={!stageName.trim() || pending}
            >
              <Plus /> Add stage
            </Button>
          </form>
        </div>
      </CardContent>
    </Card>
  );
}

export function PipelinesEditor({
  pipelines,
  teams,
}: {
  pipelines: PipelineView[];
  teams: Team[];
}) {
  const { run, pending } = useRun();
  const [name, setName] = useState("");
  return (
    <div className="flex flex-col gap-4">
      {pipelines.map((p) => (
        <PipelineCard
          key={`${p.id}:${p.name}:${p.default_team_id}:${p.card_fields.join(",")}:${p.stages.length}`}
          pipeline={p}
          teams={teams}
        />
      ))}
      <form
        className="flex max-w-md items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          run(
            () =>
              createPipeline({
                name,
                default_team_id: null,
                card_fields: ["phone", "source", "assignee", "created"],
              }),
            "Pipeline created.",
          );
          setName("");
        }}
      >
        <Input
          aria-label="New pipeline name"
          placeholder="New pipeline name"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" disabled={!name.trim() || pending}>
          <Plus /> Add pipeline
        </Button>
      </form>
    </div>
  );
}
