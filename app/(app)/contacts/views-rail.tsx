"use client";

import * as React from "react";
import { Copy, Layers, MoreHorizontal, Plus, RefreshCw, Users } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { SegmentSummary } from "@/lib/contacts/server";
import { CONTACT_VIEWS } from "@/lib/contacts/views";
import { cn } from "@/lib/utils";

import { deleteSegment, refreshSegmentCounts } from "./actions";

export function ViewsRail({
  view,
  segmentId,
  showDupes,
  segments,
  canManage,
  onSelectView,
  onSelectSegment,
  onShowDupes,
  onNewSegment,
  onEditSegment,
  onSegmentsChanged,
}: {
  view: string;
  segmentId: string | null;
  showDupes: boolean;
  segments: SegmentSummary[];
  canManage: boolean;
  onSelectView: (view: string) => void;
  onSelectSegment: (id: string) => void;
  onShowDupes: () => void;
  onNewSegment: () => void;
  onEditSegment: (id: string) => void;
  onSegmentsChanged: (segments: SegmentSummary[]) => void;
}) {
  const [refreshing, setRefreshing] = React.useState(false);

  async function refresh() {
    setRefreshing(true);
    const res = await refreshSegmentCounts();
    setRefreshing(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    onSegmentsChanged(
      segments.map((s) => ({ ...s, member_count: res.data.counts[s.id] ?? s.member_count })),
    );
  }

  async function remove(id: string) {
    if (!confirm("Delete this segment? Contacts are not deleted.")) return;
    const res = await deleteSegment(id);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(res.message);
    onSegmentsChanged(segments.filter((s) => s.id !== id));
    if (segmentId === id) onSelectView("all");
  }

  const item = (
    active: boolean,
    onClick: () => void,
    label: React.ReactNode,
    right?: React.ReactNode,
  ) => (
    <div
      className={cn(
        "group flex items-center rounded-md text-sm",
        active ? "bg-accent font-medium" : "hover:bg-accent/60 text-muted-foreground",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
      >
        {label}
      </button>
      {right}
    </div>
  );

  return (
    <aside className="hidden w-56 shrink-0 flex-col gap-4 md:flex" aria-label="Contact views">
      <nav className="flex flex-col gap-0.5">
        <h3 className="text-muted-foreground px-2 text-xs font-semibold tracking-wide uppercase">
          Views
        </h3>
        {CONTACT_VIEWS.map((v) =>
          item(
            !showDupes && !segmentId && view === v.key,
            () => onSelectView(v.key),
            <>
              <Users className="size-4 shrink-0" />
              <span className="truncate">{v.label}</span>
            </>,
          ),
        )}
        {item(
          showDupes,
          onShowDupes,
          <>
            <Copy className="size-4 shrink-0" />
            <span className="truncate">Duplicates</span>
          </>,
        )}
      </nav>
      <nav className="flex min-h-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center justify-between px-2">
          <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
            Segments
          </h3>
          <div className="flex">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh counts"
              onClick={refresh}
              disabled={refreshing}
            >
              <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
            </Button>
            {canManage && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="New segment"
                onClick={onNewSegment}
              >
                <Plus className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          {segments.length === 0 && (
            <p className="text-muted-foreground px-2 py-1 text-xs">No segments yet.</p>
          )}
          {segments.map((s) =>
            item(
              segmentId === s.id,
              () => onSelectSegment(s.id),
              <>
                <Layers className={cn("size-4 shrink-0", s.kind === "dynamic" && "text-primary")} />
                <span className="truncate">{s.name}</span>
                <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                  {s.member_count.toLocaleString()}
                </span>
              </>,
              canManage ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Segment actions for ${s.name}`}
                      className="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                    >
                      <MoreHorizontal className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => onEditSegment(s.id)}>Edit</DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => remove(s.id)}>
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : undefined,
            ),
          )}
        </ScrollArea>
        <p className="text-muted-foreground px-2 text-[11px]">
          <span className="text-primary">●</span> dynamic (saved filter) · static (hand-picked)
        </p>
      </nav>
    </aside>
  );
}
