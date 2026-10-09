"use client";

import { Bookmark, Share2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { EnquiryViewSummary, PipelineInfo } from "@/lib/enquiries/server";
import { cn } from "@/lib/utils";

/** Left rail: pipelines (with counts) and saved views. */
export function PipelinesRail({
  pipelines,
  counts,
  activePipelineId,
  views,
  activeViewId,
  onSelectPipeline,
  onSelectView,
  onDeleteView,
}: {
  pipelines: PipelineInfo[];
  counts: Record<string, number>;
  activePipelineId: string | null;
  views: EnquiryViewSummary[];
  activeViewId: string | null;
  onSelectPipeline: (id: string | null) => void;
  onSelectView: (v: EnquiryViewSummary) => void;
  onDeleteView: (v: EnquiryViewSummary) => void;
}) {
  const item = (active: boolean) =>
    cn(
      "hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
      active && "bg-accent font-medium",
    );
  const live = pipelines.filter((p) => !p.archived);
  return (
    <nav
      aria-label="Pipelines and views"
      className="hidden w-56 shrink-0 flex-col gap-4 overflow-y-auto lg:flex"
    >
      <div className="flex flex-col gap-0.5">
        <h2 className="text-muted-foreground px-2 pb-1 text-xs font-semibold tracking-wide uppercase">
          Pipelines
        </h2>
        <button
          type="button"
          className={item(activePipelineId === null && !activeViewId)}
          onClick={() => onSelectPipeline(null)}
        >
          <span className="truncate">All pipelines</span>
          <span className="text-muted-foreground ml-auto text-xs tabular-nums">
            {Object.values(counts)
              .reduce((n, c) => n + c, 0)
              .toLocaleString()}
          </span>
        </button>
        {live.map((p) => (
          <button
            key={p.id}
            type="button"
            className={item(activePipelineId === p.id && !activeViewId)}
            onClick={() => onSelectPipeline(p.id)}
          >
            <span className="truncate">{p.name}</span>
            <span className="text-muted-foreground ml-auto text-xs tabular-nums">
              {(counts[p.id] ?? 0).toLocaleString()}
            </span>
          </button>
        ))}
        {live.length === 0 && (
          <p className="text-muted-foreground px-2 text-xs">
            No pipelines yet. Create one in Settings → Enquiries.
          </p>
        )}
      </div>
      {views.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <h2 className="text-muted-foreground px-2 pb-1 text-xs font-semibold tracking-wide uppercase">
            Views
          </h2>
          {views.map((v) => (
            <div key={v.id} className="group flex items-center">
              <button
                type="button"
                className={item(activeViewId === v.id)}
                onClick={() => onSelectView(v)}
              >
                <Bookmark className="size-3.5 shrink-0" />
                <span className="truncate">{v.name}</span>
                {(v.shared_all || v.shared_team_ids.length > 0) && (
                  <Share2 className="text-muted-foreground size-3 shrink-0" aria-label="Shared" />
                )}
              </button>
              {v.mine && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  aria-label={`Delete view ${v.name}`}
                  onClick={() => onDeleteView(v)}
                >
                  <Trash2 />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </nav>
  );
}
