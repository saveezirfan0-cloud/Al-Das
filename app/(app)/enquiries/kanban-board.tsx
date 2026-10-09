"use client";

import * as React from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatDate, tagClass, timeAgo } from "@/lib/contacts/format";
import { DEFAULT_CARD_FIELDS } from "@/lib/enquiries/constants";
import type { EnquiryRow } from "@/lib/enquiries/query";
import type { PipelineInfo } from "@/lib/enquiries/server";
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";

import type { BoardColumn } from "./actions";
import { SlaBadge, StatusBadge, lookupMaps, type LookupMaps } from "./enquiries-grid";
import type { EnquiriesBootstrap } from "./types";

const columnId = (stageId: string) => `col:${stageId}`;

/** Prefer the column under the pointer; fall back to the nearest rectangle (keyboard drags). */
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length ? hits : rectIntersection(args);
};

function CardBody({
  row,
  fields,
  lk,
  b,
}: {
  row: EnquiryRow;
  fields: readonly string[];
  lk: LookupMaps;
  b: EnquiriesBootstrap;
}) {
  const show = (k: string) => fields.includes(k);
  const lines: React.ReactNode[] = [];
  if (show("contact") && row.contact?.full_name)
    lines.push(
      <span key="c" className="font-medium">
        {row.contact.full_name}
      </span>,
    );
  if (show("phone") && row.contact?.phone_e164)
    lines.push(
      <span key="p" className="tabular-nums">
        {formatPhone(row.contact.phone_e164)}
      </span>,
    );
  if (show("source") && row.source) lines.push(<span key="s">{row.source}</span>);
  if (show("assignee") && row.assignee_id)
    lines.push(<span key="a">→ {lk.user.get(row.assignee_id) ?? "Unknown"}</span>);
  if (show("est_value") && row.est_value !== null)
    lines.push(
      <span key="v" className="tabular-nums">
        {Number(row.est_value).toLocaleString()}
      </span>,
    );
  if (show("appt_date") && row.appt_date)
    lines.push(<span key="d">Appt {formatDate(row.appt_date, b.timezone)}</span>);
  if (show("location") && row.location_id)
    lines.push(<span key="l">{lk.location.get(row.location_id)}</span>);
  if (show("department") && row.department_id)
    lines.push(<span key="dp">{lk.department.get(row.department_id)}</span>);
  if (show("specialist") && row.specialist_id)
    lines.push(<span key="sp">{lk.specialist.get(row.specialist_id)}</span>);
  if (show("service") && row.service_id)
    lines.push(<span key="sv">{lk.service.get(row.service_id)}</span>);
  if (show("created_by") && row.created_by)
    lines.push(<span key="cb">by {lk.user.get(row.created_by) ?? "Unknown"}</span>);
  if (show("created_at"))
    lines.push(
      <span key="ca" className="text-muted-foreground">
        {formatDate(row.created_at, b.timezone)}
      </span>,
    );
  if (show("stage_age"))
    lines.push(
      <span key="sa" className="text-muted-foreground">
        {timeAgo(row.stage_entered_at).replace(" ago", "")} in stage
      </span>,
    );
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="line-clamp-2 text-sm leading-snug font-medium">{row.title}</span>
        {show("number") && (
          <span className="text-muted-foreground text-xs tabular-nums">#{row.number}</span>
        )}
      </div>
      {lines.length > 0 && (
        <div className="text-muted-foreground flex flex-col gap-0.5 text-xs">{lines}</div>
      )}
      <div className="flex flex-wrap gap-1 empty:hidden">
        {row.status !== "open" && <StatusBadge status={row.status} />}
        <SlaBadge row={row} />
      </div>
    </>
  );
}

function Card({
  row,
  fields,
  lk,
  b,
  draggable,
  onOpen,
}: {
  row: EnquiryRow;
  fields: readonly string[];
  lk: LookupMaps;
  b: EnquiriesBootstrap;
  draggable: boolean;
  onOpen: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: row.id,
    disabled: !draggable,
  });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      aria-label={`Enquiry ${row.number}: ${row.title}`}
      onClick={() => onOpen(row.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(row.id);
        else listeners?.onKeyDown?.(e as never);
      }}
      className={cn(
        "bg-card hover:border-primary/40 flex cursor-pointer flex-col gap-1.5 rounded-lg border p-2.5 text-left shadow-xs transition-colors",
        isDragging && "opacity-40",
      )}
    >
      <CardBody row={row} fields={fields} lk={lk} b={b} />
    </div>
  );
}

function Column({
  stage,
  col,
  fields,
  lk,
  b,
  canMove,
  onOpen,
  onAdd,
  onLoadMore,
  loadingMore,
}: {
  stage: PipelineInfo["stages"][number];
  col: BoardColumn;
  fields: readonly string[];
  lk: LookupMaps;
  b: EnquiriesBootstrap;
  canMove: boolean;
  onOpen: (id: string) => void;
  onAdd: (stageId: string) => void;
  onLoadMore: (stageId: string) => void;
  loadingMore: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: columnId(stage.id), disabled: !canMove });
  const remaining = col.total - col.rows.length;
  return (
    <section
      ref={setNodeRef}
      aria-label={`${stage.name}, ${col.total} enquiries`}
      className={cn(
        "bg-muted/40 flex max-h-full w-72 shrink-0 flex-col rounded-xl border transition-colors",
        isOver && "border-primary bg-primary/5",
      )}
    >
      <header className="flex items-center gap-2 px-3 py-2">
        <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${tagClass(stage.color)}`}>
          {stage.name}
        </span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {col.total.toLocaleString()}
        </span>
        {b.can.manage && (
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-7"
            aria-label={`Add enquiry to ${stage.name}`}
            onClick={() => onAdd(stage.id)}
          >
            <Plus />
          </Button>
        )}
      </header>
      <div className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {col.rows.map((r) => (
          <Card
            key={r.id}
            row={r}
            fields={fields}
            lk={lk}
            b={b}
            draggable={canMove}
            onOpen={onOpen}
          />
        ))}
        {col.rows.length === 0 && (
          <p className="text-muted-foreground px-1 py-4 text-center text-xs">No enquiries</p>
        )}
        {remaining > 0 && (
          <Button
            variant="ghost"
            size="sm"
            disabled={loadingMore}
            onClick={() => onLoadMore(stage.id)}
          >
            {loadingMore && <Loader2 className="animate-spin" />} Load {Math.min(remaining, 50)}{" "}
            more ({remaining.toLocaleString()} left)
          </Button>
        )}
      </div>
    </section>
  );
}

/** Kanban over one pipeline: columns are stages, drag a card to change its stage. */
export function KanbanBoard({
  pipeline,
  columns,
  bootstrap,
  loading,
  loadingMoreStage,
  onMove,
  onOpen,
  onAdd,
  onLoadMore,
}: {
  pipeline: PipelineInfo;
  columns: BoardColumn[];
  bootstrap: EnquiriesBootstrap;
  loading: boolean;
  loadingMoreStage: string | null;
  onMove: (enquiryId: string, toStageId: string) => void;
  onOpen: (id: string) => void;
  onAdd: (stageId: string) => void;
  onLoadMore: (stageId: string) => void;
}) {
  const lk = React.useMemo(() => lookupMaps(bootstrap), [bootstrap]);
  const fields = pipeline.card_fields.length ? pipeline.card_fields : DEFAULT_CARD_FIELDS;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const [active, setActive] = React.useState<EnquiryRow | null>(null);
  const byStage = new Map(columns.map((c) => [c.stageId, c]));
  const canMove = bootstrap.can.manage;

  function onDragStart(e: DragStartEvent) {
    const id = String(e.active.id);
    setActive(columns.flatMap((c) => c.rows).find((r) => r.id === id) ?? null);
  }

  function onDragEnd(e: DragEndEvent) {
    setActive(null);
    const overId = e.over ? String(e.over.id) : null;
    if (!overId?.startsWith("col:")) return;
    const toStage = overId.slice(4);
    const row = columns.flatMap((c) => c.rows).find((r) => r.id === String(e.active.id));
    if (!row || row.stage_id === toStage) return;
    onMove(row.id, toStage);
  }

  return (
    <div className="relative flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2" aria-busy={loading}>
      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActive(null)}
      >
        {pipeline.stages.map((s) => (
          <Column
            key={s.id}
            stage={s}
            col={byStage.get(s.id) ?? { stageId: s.id, total: 0, rows: [] }}
            fields={fields}
            lk={lk}
            b={bootstrap}
            canMove={canMove}
            onOpen={onOpen}
            onAdd={onAdd}
            onLoadMore={onLoadMore}
            loadingMore={loadingMoreStage === s.id}
          />
        ))}
        <DragOverlay>
          {active ? (
            <div className="bg-card flex w-68 cursor-grabbing flex-col gap-1.5 rounded-lg border p-2.5 shadow-lg">
              <CardBody row={active} fields={fields} lk={lk} b={bootstrap} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      {pipeline.stages.length === 0 && (
        <p className="text-muted-foreground m-auto text-sm">
          This pipeline has no stages yet. Add some in Settings → Enquiries.
        </p>
      )}
      {loading && (
        <div className="bg-background/40 pointer-events-none absolute inset-0 flex items-start justify-center pt-10">
          <Loader2 className="text-muted-foreground size-5 animate-spin" />
        </div>
      )}
    </div>
  );
}
