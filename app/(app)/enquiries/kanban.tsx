"use client";

import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { AlertTriangle, Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { isCardField, type CardFieldKey } from "@/lib/enquiries/columns";
import type { BoardColumn, EnquiryRow, PipelineView } from "@/lib/enquiries/types";
import { cn } from "@/lib/utils";

import { StageDot, StatusBadge } from "./badges";
import { cardFieldText, slaChip } from "./format";

function CardBody({
  row,
  fields,
  timezone,
  slaHours,
}: {
  row: EnquiryRow;
  fields: CardFieldKey[];
  timezone: string;
  slaHours: number | null;
}) {
  const sla = slaChip(row, slaHours);
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="text-muted-foreground text-xs tabular-nums">#{row.number}</span>
        {row.status !== "open" && <StatusBadge status={row.status} />}
        {sla?.breached && row.status === "open" && (
          <span
            title={sla.text}
            className="flex items-center gap-1 text-xs font-medium text-red-600"
          >
            <AlertTriangle className="size-3" aria-hidden /> SLA
          </span>
        )}
      </div>
      <div className="mt-0.5 text-sm leading-snug font-medium">
        {row.patient || row.title || `Enquiry #${row.number}`}
      </div>
      {row.title && row.patient && (
        <div className="text-muted-foreground mt-0.5 truncate text-xs">{row.title}</div>
      )}
      <dl className="text-muted-foreground mt-1.5 flex flex-col gap-0.5 text-xs">
        {fields.map((k) => {
          const text = cardFieldText(k, row, timezone);
          return text ? (
            <div key={k} className="truncate">
              {text}
            </div>
          ) : null;
        })}
      </dl>
    </>
  );
}

function Card({
  row,
  fields,
  timezone,
  slaHours,
  canDrag,
  onOpen,
}: {
  row: EnquiryRow;
  fields: CardFieldKey[];
  timezone: string;
  slaHours: number | null;
  canDrag: boolean;
  onOpen: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: row.id,
    disabled: !canDrag,
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      role="button"
      tabIndex={0}
      aria-label={`Enquiry ${row.number}, ${row.patient || row.title}. Open details.`}
      onClick={() => onOpen(row.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(row.id);
      }}
      className={cn(
        "bg-card hover:border-primary/40 focus-visible:ring-ring/50 cursor-pointer rounded-md border p-2.5 text-left shadow-xs outline-none focus-visible:ring-[3px]",
        isDragging && "opacity-40",
      )}
    >
      <CardBody row={row} fields={fields} timezone={timezone} slaHours={slaHours} />
    </div>
  );
}

function Column({
  stage,
  column,
  fields,
  timezone,
  slaHours,
  canManage,
  loading,
  onOpen,
  onAdd,
  onLoadMore,
}: {
  stage: PipelineView["stages"][number];
  column: BoardColumn | undefined;
  fields: CardFieldKey[];
  timezone: string;
  slaHours: number | null;
  canManage: boolean;
  loading: boolean;
  onOpen: (id: string) => void;
  onAdd: (stageId: string) => void;
  onLoadMore: (stageId: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const rows = column?.rows ?? [];
  const total = column?.total ?? 0;
  return (
    <section
      aria-label={`${stage.name}, ${total} enquiries`}
      className="bg-muted/40 flex w-72 shrink-0 flex-col rounded-lg border"
    >
      <header className="flex items-center justify-between gap-2 px-3 py-2">
        <h3 className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <StageDot color={stage.color} />
          <span className="truncate">{stage.name}</span>
          <span className="text-muted-foreground text-xs font-normal tabular-nums">{total}</span>
        </h3>
        {canManage && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Add enquiry to ${stage.name}`}
            onClick={() => onAdd(stage.id)}
          >
            <Plus />
          </Button>
        )}
      </header>
      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2",
          isOver && "bg-primary/5 rounded-b-lg",
        )}
      >
        {rows.map((r) => (
          <Card
            key={r.id}
            row={r}
            fields={fields}
            timezone={timezone}
            slaHours={slaHours}
            canDrag={canManage}
            onOpen={onOpen}
          />
        ))}
        {loading && rows.length === 0 && (
          <div className="text-muted-foreground flex items-center gap-2 p-2 text-xs">
            <Loader2 className="size-3 animate-spin" aria-hidden /> Loading…
          </div>
        )}
        {!loading && rows.length === 0 && (
          <p className="text-muted-foreground p-2 text-center text-xs">No enquiries</p>
        )}
        {rows.length < total && (
          <Button variant="ghost" size="sm" onClick={() => onLoadMore(stage.id)}>
            Show more ({total - rows.length})
          </Button>
        )}
      </div>
    </section>
  );
}

/** Stage columns with drag-and-drop between them. Moves are optimistic; the parent rolls back on error. */
export function Kanban({
  pipeline,
  columns,
  loading,
  canManage,
  timezone,
  slaHours,
  onOpen,
  onMove,
  onAdd,
  onLoadMore,
}: {
  pipeline: PipelineView;
  columns: BoardColumn[];
  loading: boolean;
  canManage: boolean;
  timezone: string;
  slaHours: number | null;
  onOpen: (id: string) => void;
  onMove: (enquiryId: string, toStageId: string) => void;
  onAdd: (stageId: string) => void;
  onLoadMore: (stageId: string) => void;
}) {
  const [active, setActive] = useState<EnquiryRow | null>(null);
  // A small movement threshold keeps a plain click from starting a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const fields = pipeline.card_fields.filter(isCardField);

  function findRow(id: string): EnquiryRow | undefined {
    for (const c of columns) {
      const r = c.rows.find((x) => x.id === id);
      if (r) return r;
    }
    return undefined;
  }

  function onDragStart(e: DragStartEvent) {
    setActive(findRow(String(e.active.id)) ?? null);
  }

  function onDragEnd(e: DragEndEvent) {
    setActive(null);
    const row = findRow(String(e.active.id));
    const to = e.over ? String(e.over.id) : null;
    if (!row || !to || row.stage_id === to) return;
    if (pipeline.stages.some((s) => s.id === to)) onMove(row.id, to);
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActive(null)}
    >
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
        {pipeline.stages.map((s) => (
          <Column
            key={s.id}
            stage={s}
            column={columns.find((c) => c.stage_id === s.id)}
            fields={fields}
            timezone={timezone}
            slaHours={slaHours}
            canManage={canManage}
            loading={loading}
            onOpen={onOpen}
            onAdd={onAdd}
            onLoadMore={onLoadMore}
          />
        ))}
      </div>
      <DragOverlay>
        {active ? (
          <div className="bg-card w-72 rotate-1 rounded-md border p-2.5 shadow-lg">
            <CardBody row={active} fields={fields} timezone={timezone} slaHours={slaHours} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
