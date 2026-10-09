"use client";

import * as React from "react";
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
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";

import { cn } from "@/lib/utils";

/** Drag handle + row wrapper for one sortable item. */
export function SortableItem({
  id,
  children,
  className,
  handleLabel = "Drag to reorder",
}: {
  id: string;
  children: React.ReactNode;
  className?: string;
  handleLabel?: string;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("flex items-center gap-2", isDragging && "relative z-10 opacity-80", className)}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        aria-label={handleLabel}
        className="text-muted-foreground hover:text-foreground cursor-grab touch-none rounded p-1 active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" />
      </button>
      {children}
    </div>
  );
}

/** Vertical drag-and-drop (pointer + keyboard) list. `onReorder` receives the new id order. */
export function SortableList({
  ids,
  onReorder,
  children,
  className,
}: {
  ids: string[];
  onReorder: (ids: string[]) => void;
  children: React.ReactNode;
  className?: string;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(ids, from, to));
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className={cn("flex flex-col gap-2", className)}>{children}</div>
      </SortableContext>
    </DndContext>
  );
}
