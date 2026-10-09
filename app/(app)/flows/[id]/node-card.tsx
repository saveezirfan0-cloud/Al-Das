"use client";

import * as React from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  AlarmClock,
  AlertTriangle,
  Bell,
  Bot,
  Briefcase,
  CalendarPlus,
  CheckSquare,
  CircleHelp,
  Clock3,
  FileText,
  Flag,
  GitBranch,
  Globe,
  ListChecks,
  MessageSquare,
  MessageSquareText,
  Play,
  Repeat,
  StickyNote,
  UserCog,
  UserPlus,
  XCircle,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { handlesFor, NODE_META, type FlowOption, type NodeType } from "@/lib/flow-engine/types";

import type { CanvasData } from "./graph-model";
import { nodeSummary } from "./node-forms";
import type { BuilderLookups } from "./lookups";

export const NODE_ICON: Record<NodeType, LucideIcon> = {
  trigger: Zap,
  message: MessageSquare,
  question: CircleHelp,
  quick_reply: ListChecks,
  template: FileText,
  branch: GitBranch,
  wait: Clock3,
  office_hours: AlarmClock,
  run_flow: Repeat,
  end_flow: Flag,
  assign_to: UserPlus,
  close_conversation: XCircle,
  add_comment: StickyNote,
  update_contact: UserCog,
  enquiry: Briefcase,
  add_task: CheckSquare,
  portal_record: MessageSquareText,
  appointment: CalendarPlus,
  api_action: Globe,
  send_notification: Bell,
};

const GROUP_TONE: Record<string, string> = {
  Start: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  Messaging: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  Logic: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
  Conversation: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  CRM: "bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200",
  Integrations: "bg-slate-200 text-slate-900 dark:bg-slate-800 dark:text-slate-200",
};
export const toneFor = (type: NodeType) => GROUP_TONE[NODE_META[type].group] ?? GROUP_TONE.Logic;

function handleLabel(handle: string, data: Record<string, unknown>, only: boolean): string {
  if (handle === "default") return only ? "" : "Next";
  if (handle === "fallback") return "Fallback";
  if (handle === "true") return "Yes";
  if (handle === "false") return "No";
  if (handle === "inside") return "Open";
  if (handle === "outside") return "Closed";
  if (handle.startsWith("option:")) {
    const id = handle.slice(7);
    const opt = (Array.isArray(data.options) ? (data.options as FlowOption[]) : []).find(
      (o) => o.id === id,
    );
    return opt?.title || id;
  }
  return handle;
}

export type CardExtras = {
  issues: Array<{ severity: "error" | "warning"; message: string }>;
  lookups: BuilderLookups;
  onDeleteRequest?: (id: string) => void;
};

export function FlowNodeCard({
  data,
  selected,
}: NodeProps & { data: CanvasData & Partial<CardExtras> }) {
  const type = data.nodeType;
  const meta = NODE_META[type];
  const Icon = NODE_ICON[type] ?? Bot;
  const handles = handlesFor(type, data.config);
  const summary = data.lookups ? nodeSummary(type, data.config, data.lookups) : "";
  const errors = (data.issues ?? []).filter((i) => i.severity === "error");
  const warnings = (data.issues ?? []).filter((i) => i.severity === "warning");

  return (
    <div
      className={cn(
        "bg-card w-60 rounded-lg border shadow-sm",
        selected && "ring-primary ring-2",
        errors.length > 0 && "border-destructive",
      )}
      role="group"
      aria-label={`${meta.label} step`}
    >
      {type !== "trigger" ? (
        <Handle type="target" position={Position.Left} className="!size-3" aria-label="Incoming" />
      ) : null}
      <div className="flex items-center gap-2 p-2.5">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md",
            toneFor(type),
          )}
        >
          {type === "trigger" ? <Play className="size-3.5" /> : <Icon className="size-3.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 text-sm font-medium">
            <span className="truncate">{meta.label}</span>
            {errors.length > 0 ? (
              <AlertTriangle
                className="text-destructive size-3.5 shrink-0"
                aria-label={`${errors.length} problem${errors.length > 1 ? "s" : ""}`}
              />
            ) : warnings.length > 0 ? (
              <AlertTriangle
                className="size-3.5 shrink-0 text-amber-500"
                aria-label="Has warnings"
              />
            ) : null}
          </div>
          {summary ? (
            <div className="text-muted-foreground truncate text-xs">{summary}</div>
          ) : (
            <div className="text-muted-foreground truncate text-xs">{meta.description}</div>
          )}
        </div>
      </div>
      {handles.length > 0 ? (
        <div className="border-t">
          {handles.map((h) => {
            const label = handleLabel(h, data.config, handles.length === 1);
            return (
              <div key={h} className="relative flex h-6 items-center justify-end pr-4 text-[11px]">
                <span className="text-muted-foreground max-w-[10rem] truncate">{label}</span>
                <Handle
                  id={h}
                  type="source"
                  position={Position.Right}
                  className="!size-3"
                  aria-label={label ? `Exit: ${label}` : "Exit"}
                />
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
