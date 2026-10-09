"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Bell, CalendarPlus, CheckSquare, Clock, Database, FlagOff, GitBranch, Globe, ListChecks, MessageCircle, MessageSquareText, MousePointerClick, Play, Reply, StickyNote, UserCog, UserPen, Workflow, XCircle, Zap } from "lucide-react";

import { defFor, outputsFor } from "@/lib/flow-engine/catalog";
import { TRIGGER_LABELS } from "@/lib/flow-engine/labels";
import { cn } from "@/lib/utils";

export type CanvasNodeData = {
  kind: string;
  config: Record<string, unknown>;
  /** Trigger label shown on the trigger node. */
  triggerType?: string;
  issue?: "error" | "warning";
};

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  trigger: Zap,
  message: MessageCircle,
  question: ListChecks,
  quick_reply: Reply,
  template: MessageSquareText,
  branch: GitBranch,
  wait: Clock,
  office_hours: Clock,
  run_flow: Workflow,
  end_flow: FlagOff,
  assign_to: UserCog,
  close_conversation: XCircle,
  add_comment: StickyNote,
  update_contact_field: UserPen,
  create_enquiry: MousePointerClick,
  add_task: CheckSquare,
  portal_record: Database,
  book_appointment: CalendarPlus,
  api_action: Globe,
  send_notification: Bell,
};

export function summarize(kind: string, c: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (kind) {
    case "message":
    case "question":
    case "quick_reply":
    case "add_comment":
      return s(c.text);
    case "wait":
      return `${String(c.amount ?? "")} ${s(c.unit)}`.trim();
    case "api_action":
      return `${s(c.method)} ${s(c.url)}`.trim();
    case "update_contact_field":
      return `${s(c.field)} = ${s(c.value)}`;
    case "send_notification":
      return s(c.title);
    default:
      return "";
  }
}

export function FlowCanvasNode({ data, selected }: NodeProps) {
  const d = data as unknown as CanvasNodeData;
  const isTrigger = d.kind === "trigger";
  const def = defFor(d.kind);
  const Icon = ICONS[d.kind] ?? Play;
  const outputs = outputsFor(d.kind, d.config);
  const summary = isTrigger ? (TRIGGER_LABELS[d.triggerType ?? ""] ?? "Choose a trigger") : summarize(d.kind, d.config);

  return (
    <div
      className={cn(
        "bg-card min-w-52 max-w-64 rounded-xl border shadow-sm",
        selected && "ring-primary ring-2",
        d.issue === "error" && "border-destructive",
        d.issue === "warning" && !selected && "border-amber-400",
        isTrigger && "border-primary/50",
      )}
    >
      {!isTrigger && <Handle type="target" position={Position.Left} aria-label="Input" className="!bg-muted-foreground !size-2.5" />}
      <div className="flex items-start gap-2 p-3">
        <span className={cn("mt-0.5 rounded-md p-1.5", isTrigger ? "bg-primary text-primary-foreground" : "bg-muted")}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{isTrigger ? "Trigger" : (def?.label ?? d.kind)}</div>
          {summary && <div className="text-muted-foreground line-clamp-2 break-words text-xs">{summary}</div>}
        </div>
      </div>
      {outputs.length > 0 && (
        <ul className="border-t py-1">
          {outputs.map((o) => (
            <li key={o.id} className="relative flex items-center justify-end px-3 py-0.5 text-[11px] text-muted-foreground">
              {o.label}
              <Handle id={o.id} type="source" position={Position.Right} aria-label={`Output: ${o.label}`} className={cn("!size-2.5", o.id === "fallback" ? "!bg-amber-500" : "!bg-primary")} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
