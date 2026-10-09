"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { CheckCircle2, Copy, Hourglass, Loader2, MoreHorizontal, Plus, ScrollText, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TRIGGER_LABELS } from "@/lib/flow-engine/labels";
import { TRIGGER_TYPES } from "@/lib/flow-engine/types";

import { createFlow, deleteFlow, duplicateFlow, setFlowStatus } from "./actions";

export type FlowRow = {
  id: string;
  name: string;
  status: "draft" | "active" | "paused";
  trigger_type: string;
  channel: string;
  version: number;
  updated_at: string;
  ok: number;
  failed: number;
  waiting: number;
};

const STATUS_STYLE: Record<FlowRow["status"], string> = {
  draft: "bg-muted text-muted-foreground",
  active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  paused: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
};

export function FlowsList({ rows }: { rows: FlowRow[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<string>("shortcut");
  const [pending, startTransition] = useTransition();

  function run(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>, after?: () => void) {
    startTransition(async () => {
      const r = await fn();
      if (r.ok) {
        if (r.message) toast.success(r.message);
        after?.();
        router.refresh();
      } else toast.error(r.error);
    });
  }

  function create() {
    startTransition(async () => {
      const r = await createFlow({ name, trigger_type: trigger as never });
      if (r.ok) router.push(`/flows/${r.data.id}`);
      else toast.error(r.error);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button onClick={() => setOpen(true)}>
          <Plus /> New flow
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">No flows yet. Create one to automate replies, reminders and hand-overs.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Trigger</TableHead>
              <TableHead>Number</TableHead>
              <TableHead>Runs</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((f) => (
              <TableRow key={f.id}>
                <TableCell>
                  <Link href={`/flows/${f.id}`} className="font-medium hover:underline">
                    {f.name}
                  </Link>
                  <div className="text-muted-foreground text-xs">{f.version > 0 ? `v${f.version}` : "Never published"}</div>
                </TableCell>
                <TableCell className="text-sm">{TRIGGER_LABELS[f.trigger_type] ?? f.trigger_type}</TableCell>
                <TableCell className="text-sm">{f.channel}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-3 text-sm tabular-nums">
                    <span className="inline-flex items-center gap-1" title="Completed">
                      <CheckCircle2 className="size-3.5 text-emerald-600" /> {f.ok}
                    </span>
                    <span className="inline-flex items-center gap-1" title="Failed">
                      <TriangleAlert className="size-3.5 text-amber-600" /> {f.failed}
                    </span>
                    <span className="inline-flex items-center gap-1" title="Running or waiting">
                      <Hourglass className="size-3.5 text-sky-600" /> {f.waiting}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className={STATUS_STYLE[f.status]}>
                    {f.status === "draft" ? "Draft" : f.status === "active" ? "Active" : "Paused"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${f.name}`}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem asChild>
                        <Link href={`/flows/${f.id}/logs`}>
                          <ScrollText /> Logs
                        </Link>
                      </DropdownMenuItem>
                      {f.status === "active" && <DropdownMenuItem onSelect={() => run(() => setFlowStatus(f.id, "paused"))}>Pause</DropdownMenuItem>}
                      {f.status === "paused" && <DropdownMenuItem onSelect={() => run(() => setFlowStatus(f.id, "active"))}>Resume</DropdownMenuItem>}
                      <DropdownMenuItem onSelect={() => run(() => duplicateFlow(f.id))}>
                        <Copy /> Duplicate
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive"
                        onSelect={() => {
                          if (confirm(`Delete "${f.name}"? Its run history is deleted too.`)) run(() => deleteFlow(f.id));
                        }}
                      >
                        <Trash2 /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New flow</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Flow name" aria-label="Flow name" autoFocus />
            <Select value={trigger} onValueChange={setTrigger}>
              <SelectTrigger aria-label="Trigger">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRIGGER_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TRIGGER_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={create} disabled={pending || !name.trim()}>
              {pending && <Loader2 className="animate-spin" />} Create and open
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
