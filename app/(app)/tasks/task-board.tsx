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
import { ListChecks, Repeat } from "lucide-react";

import { formatDateTime } from "@/lib/contacts/format";
import { dueState } from "@/lib/tasks/due";
import {
  TASK_PRIORITY_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  compareForBoard,
  type TaskPriority,
  type TaskStatus,
} from "@/lib/tasks/status";
import { cn } from "@/lib/utils";

import type { TaskRow } from "./actions";

const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length ? hits : rectIntersection(args);
};

const PRIORITY_CLASS: Record<TaskPriority, string> = {
  urgent: "bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300",
  high: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  normal: "",
  low: "bg-muted text-muted-foreground",
};

function CardBody({
  t,
  timezone,
  userName,
}: {
  t: TaskRow;
  timezone: string;
  userName: Map<string, string>;
}) {
  const overdue = dueState(t, new Date()) === "overdue";
  const priority = t.priority as TaskPriority;
  return (
    <>
      <span
        className={cn("line-clamp-2 text-sm leading-snug font-medium", t.done && "line-through")}
      >
        {t.subject}
      </span>
      <span
        className={cn(
          "text-xs tabular-nums",
          overdue ? "text-destructive font-medium" : "text-muted-foreground",
        )}
      >
        {formatDateTime(t.due_at, timezone)}
        {overdue && " · overdue"}
      </span>
      <span className="text-muted-foreground flex flex-wrap items-center gap-1 text-xs">
        {t.assignee_id ? (userName.get(t.assignee_id) ?? "Colleague") : "Unassigned"}
        {t.contact?.full_name && <span>· {t.contact.full_name}</span>}
        {priority !== "normal" && (
          <span className={cn("rounded px-1 text-[10px] font-medium", PRIORITY_CLASS[priority])}>
            {TASK_PRIORITY_LABELS[priority]}
          </span>
        )}
        {t.recurrence && <Repeat className="size-3" aria-label="Repeats" />}
        {t.checklist_template_id && <ListChecks className="size-3" aria-label="Daily checklist" />}
      </span>
    </>
  );
}

function Card({
  t,
  timezone,
  userName,
  draggable,
  onOpen,
}: {
  t: TaskRow;
  timezone: string;
  userName: Map<string, string>;
  draggable: boolean;
  onOpen: (t: TaskRow) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: t.id,
    disabled: !draggable,
  });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      aria-label={`Task: ${t.subject}`}
      onClick={() => onOpen(t)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(t);
        else listeners?.onKeyDown?.(e as never);
      }}
      className={cn(
        "bg-card hover:border-primary/40 flex cursor-pointer flex-col gap-1 rounded-lg border p-2.5 text-left shadow-xs transition-colors",
        isDragging && "opacity-40",
      )}
    >
      <CardBody t={t} timezone={timezone} userName={userName} />
    </div>
  );
}

function Column({
  status,
  rows,
  timezone,
  userName,
  canMove,
  onOpen,
  note,
}: {
  status: TaskStatus;
  rows: TaskRow[];
  timezone: string;
  userName: Map<string, string>;
  canMove: boolean;
  onOpen: (t: TaskRow) => void;
  note?: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${status}`, disabled: !canMove });
  return (
    <section
      ref={setNodeRef}
      aria-label={`${TASK_STATUS_LABELS[status]}, ${rows.length} tasks`}
      className={cn(
        "bg-muted/40 flex max-h-full w-72 shrink-0 flex-col rounded-xl border transition-colors",
        isOver && "border-primary bg-primary/5",
      )}
    >
      <header className="flex items-center gap-2 px-3 py-2">
        <span className="text-sm font-medium">{TASK_STATUS_LABELS[status]}</span>
        <span className="text-muted-foreground text-xs tabular-nums">{rows.length}</span>
      </header>
      <div className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {rows.map((t) => (
          <Card
            key={t.id}
            t={t}
            timezone={timezone}
            userName={userName}
            draggable={canMove}
            onOpen={onOpen}
          />
        ))}
        {rows.length === 0 && (
          <p className="text-muted-foreground px-1 py-4 text-center text-xs">Nothing here</p>
        )}
        {note && <p className="text-muted-foreground px-1 text-[11px]">{note}</p>}
      </div>
    </section>
  );
}

/** Tasks board (Phase F): one column per status; dragging a card changes its status (Done ticks it off). */
export function TaskBoard({
  rows,
  timezone,
  userName,
  canMove,
  onMove,
  onOpen,
}: {
  rows: TaskRow[];
  timezone: string;
  userName: Map<string, string>;
  canMove: boolean;
  onMove: (taskId: string, status: TaskStatus) => void;
  onOpen: (t: TaskRow) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const [active, setActive] = React.useState<TaskRow | null>(null);
  const byStatus = React.useMemo(() => {
    const m = new Map<TaskStatus, TaskRow[]>(TASK_STATUSES.map((s) => [s, []]));
    for (const t of rows) m.get((t.status as TaskStatus) ?? "todo")?.push(t);
    for (const [s, list] of m)
      list.sort(
        s === "done"
          ? (a, b) =>
              new Date(b.done_at ?? b.due_at).getTime() - new Date(a.done_at ?? a.due_at).getTime()
          : compareForBoard,
      );
    return m;
  }, [rows]);

  function onDragStart(e: DragStartEvent) {
    setActive(rows.find((r) => r.id === String(e.active.id)) ?? null);
  }
  function onDragEnd(e: DragEndEvent) {
    setActive(null);
    const overId = e.over ? String(e.over.id) : null;
    if (!overId?.startsWith("col:")) return;
    const to = overId.slice(4) as TaskStatus;
    const row = rows.find((r) => r.id === String(e.active.id));
    if (!row || row.status === to) return;
    onMove(row.id, to);
  }

  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActive(null)}
      >
        {TASK_STATUSES.map((s) => (
          <Column
            key={s}
            status={s}
            rows={byStatus.get(s) ?? []}
            timezone={timezone}
            userName={userName}
            canMove={canMove}
            onOpen={onOpen}
            note={s === "done" ? "The 30 most recently due." : undefined}
          />
        ))}
        <DragOverlay>
          {active ? (
            <div className="bg-card flex w-68 cursor-grabbing flex-col gap-1 rounded-lg border p-2.5 shadow-lg">
              <CardBody t={active} timezone={timezone} userName={userName} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
