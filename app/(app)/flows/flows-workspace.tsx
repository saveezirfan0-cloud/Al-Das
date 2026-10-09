"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Loader2,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  ScrollText,
  Trash2,
  Workflow,
  Hourglass,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FLOW_STARTERS, starterByKey } from "@/lib/flow-engine/starters";
import { TRIGGER_LABEL, TRIGGER_TYPES, type TriggerType } from "@/lib/flow-engine/types";

import { createFlow, deleteFlow, duplicateFlow, setFlowStatus } from "./actions";
import type { ChannelOption, FlowListItem, VariableItem } from "./types";
import { VariablesPanel } from "./variables-panel";

const STATUS: Record<
  FlowListItem["status"],
  { label: string; variant: "default" | "secondary" | "outline" | "success" | "warning" }
> = {
  draft: { label: "Draft", variant: "outline" },
  active: { label: "Live", variant: "success" },
  paused: { label: "Paused", variant: "warning" },
};

export function FlowsWorkspace({
  flows,
  variables,
  channels,
}: {
  flows: FlowListItem[];
  variables: VariableItem[];
  channels: ChannelOption[];
}) {
  const router = useRouter();
  const [creating, setCreating] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState<FlowListItem | null>(null);
  const channelName = new Map(channels.map((c) => [c.id, c.name]));

  async function act(
    id: string,
    fn: () => Promise<{ ok: boolean; message?: string; error?: string }>,
  ) {
    setBusy(id);
    const r = await fn();
    setBusy(null);
    if (!r.ok) return void toast.error(r.error ?? "Something went wrong.");
    if (r.message) toast.success(r.message);
    router.refresh();
  }

  return (
    <Tabs defaultValue="flows">
      <div className="flex items-center justify-between">
        <TabsList>
          <TabsTrigger value="flows">Flows ({flows.length})</TabsTrigger>
          <TabsTrigger value="variables">Variables ({variables.length})</TabsTrigger>
        </TabsList>
        <Button onClick={() => setCreating(true)}>
          <Plus className="size-4" />
          New flow
        </Button>
      </div>

      <TabsContent value="flows" className="mt-4">
        <div className="rounded-md border">
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
              {flows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground h-28 text-center">
                    <Workflow className="mx-auto mb-2 size-6 opacity-60" />
                    No flows yet. Create one to automate replies, follow-ups and back-office steps.
                  </TableCell>
                </TableRow>
              ) : (
                flows.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell>
                      <Link href={`/flows/${f.id}`} className="font-medium hover:underline">
                        {f.name}
                      </Link>
                      {f.description ? (
                        <div className="text-muted-foreground max-w-md truncate text-xs">
                          {f.description}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm">{TRIGGER_LABEL[f.trigger_type]}</TableCell>
                    <TableCell className="text-sm">
                      {(f.channel_id && channelName.get(f.channel_id)) || "All numbers"}
                    </TableCell>
                    <TableCell>
                      <div
                        className="flex items-center gap-3 text-sm tabular-nums"
                        aria-label="Completed, failed and live runs"
                      >
                        <span className="flex items-center gap-1" title="Completed">
                          <CheckCircle2 className="size-3.5 text-emerald-600" />
                          {f.completed}
                        </span>
                        <span className="flex items-center gap-1" title="Failed">
                          <AlertTriangle
                            className={`size-3.5 ${f.failed ? "text-destructive" : "text-muted-foreground"}`}
                          />
                          {f.failed}
                        </span>
                        <span className="flex items-center gap-1" title="In progress">
                          <Hourglass className="text-muted-foreground size-3.5" />
                          {f.live}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge variant={STATUS[f.status].variant}>{STATUS[f.status].label}</Badge>
                        {f.version > 0 ? (
                          <span className="text-muted-foreground text-xs">v{f.version}</span>
                        ) : null}
                        {f.unpublished && f.version > 0 ? (
                          <Badge variant="outline">unpublished changes</Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            aria-label={`Actions for ${f.name}`}
                            disabled={busy === f.id}
                          >
                            {busy === f.id ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <MoreHorizontal className="size-4" />
                            )}
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem asChild>
                            <Link href={`/flows/${f.id}`}>
                              <Workflow className="size-4" />
                              Open builder
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <Link href={`/flows/${f.id}/logs`}>
                              <ScrollText className="size-4" />
                              Run logs
                            </Link>
                          </DropdownMenuItem>
                          {f.status === "active" ? (
                            <DropdownMenuItem
                              onSelect={() => act(f.id, () => setFlowStatus(f.id, "paused"))}
                            >
                              <Pause className="size-4" />
                              Pause
                            </DropdownMenuItem>
                          ) : f.version > 0 ? (
                            <DropdownMenuItem
                              onSelect={() => act(f.id, () => setFlowStatus(f.id, "active"))}
                            >
                              <Play className="size-4" />
                              Make live
                            </DropdownMenuItem>
                          ) : null}
                          <DropdownMenuItem onSelect={() => act(f.id, () => duplicateFlow(f.id))}>
                            <Copy className="size-4" />
                            Duplicate
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => setConfirmDelete(f)}
                          >
                            <Trash2 className="size-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </TabsContent>

      <TabsContent value="variables" className="mt-4">
        <VariablesPanel variables={variables} />
      </TabsContent>

      <NewFlowDialog open={creating} onClose={() => setCreating(false)} channels={channels} />

      <Dialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete “{confirmDelete?.name}”?</DialogTitle>
            <DialogDescription>
              Runs in progress are stopped and the run history is deleted. This cannot be undone. To
              keep the history, pause the flow instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                const f = confirmDelete!;
                setConfirmDelete(null);
                await act(f.id, () => deleteFlow(f.id));
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Tabs>
  );
}

function NewFlowDialog({
  open,
  onClose,
  channels,
}: {
  open: boolean;
  onClose: () => void;
  channels: ChannelOption[];
}) {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [trigger, setTrigger] = React.useState<TriggerType>("conversation_opened");
  const [channel, setChannel] = React.useState("__all__");
  const [cron, setCron] = React.useState("0 9 * * *");
  const [busy, setBusy] = React.useState(false);
  const [starter, setStarter] = React.useState("__blank__");
  const picked = starterByKey(starter);

  async function create() {
    setBusy(true);
    const r = await createFlow({
      name,
      trigger_type: picked?.trigger_type ?? trigger,
      trigger_config: !picked && trigger === "recurring" ? { cron } : {},
      starter: picked?.key ?? null,
      channel_id: channel === "__all__" ? null : channel,
    });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    onClose();
    router.push(`/flows/${r.data.id}`);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New flow</DialogTitle>
          <DialogDescription>
            Pick what starts it. You can change this later in the builder.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="flow-name">Name</Label>
            <Input
              id="flow-name"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Welcome and triage"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Start from</Label>
            <Select value={starter} onValueChange={setStarter}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__blank__">A blank flow</SelectItem>
                {FLOW_STARTERS.map((s) => (
                  <SelectItem key={s.key} value={s.key}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {picked ? (
              <div className="text-muted-foreground space-y-1 text-xs">
                <p>{picked.description}</p>
                <p>Before publishing: {picked.needs.join("; ")}.</p>
              </div>
            ) : null}
          </div>
          {!picked ? (
            <div className="space-y-1.5">
              <Label>Trigger</Label>
              <Select value={trigger} onValueChange={(v) => setTrigger(v as TriggerType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TRIGGER_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {TRIGGER_LABEL[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <p className="text-sm">
              Starts when: <strong>{TRIGGER_LABEL[picked.trigger_type]}</strong>
            </p>
          )}
          {!picked && trigger === "recurring" ? (
            <div className="space-y-1.5">
              <Label htmlFor="flow-cron">Schedule (cron, workspace time zone)</Label>
              <Input
                id="flow-cron"
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                className="font-mono"
              />
              <p className="text-muted-foreground text-xs">
                Minute, hour, day of month, month, weekday. “0 9 * * 1-5” is 09:00 on weekdays.
              </p>
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label>WhatsApp number</Label>
            <Select value={channel} onValueChange={setChannel}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All numbers</SelectItem>
                {channels.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={create} disabled={busy || !name.trim()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
