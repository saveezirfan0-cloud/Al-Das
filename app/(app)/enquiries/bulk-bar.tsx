"use client";

import { useState, useTransition } from "react";
import { Trash2, X } from "lucide-react";
import { toast } from "sonner";

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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BULK_LIMIT } from "@/lib/enquiries/schemas";
import type { EnquiryStatus } from "@/lib/enquiries/status";
import type { PipelineView } from "@/lib/enquiries/types";

import { bulkDeleteAction, bulkUpdateAction } from "./actions";
import { StatusDialog } from "./status-dialog";
import type { EnquiriesBootstrap } from "./types";

/** Appears over the table when rows are selected: move, assign, change status, delete. */
export function BulkBar({
  ids,
  bootstrap,
  pipeline,
  onClear,
  onDone,
}: {
  ids: string[];
  bootstrap: EnquiriesBootstrap;
  pipeline: PipelineView | undefined;
  onClear: () => void;
  onDone: () => void;
}) {
  const [pending, start] = useTransition();
  const [statusTarget, setStatusTarget] = useState<EnquiryStatus | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const tooMany = ids.length > BULK_LIMIT;

  function run(fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, done: string) {
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error ?? "Something went wrong.");
      else toast.success(r.message ?? done);
      if (r.ok) onDone();
    });
  }

  function update(patch: Parameters<typeof bulkUpdateAction>[1]) {
    start(async () => {
      const r = await bulkUpdateAction(ids, patch);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      if (r.failed)
        toast.warning(
          `${r.updated} updated, ${r.failed} failed: ${r.firstError ?? "see the enquiry"}`,
        );
      else toast.success(`${r.updated} enquiries updated.`);
      setStatusTarget(null);
      onDone();
    });
  }

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="bg-card flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 shadow-xs"
    >
      <span className="text-sm font-medium">{ids.length} selected</span>
      {tooMany && (
        <span className="text-destructive text-xs">Select up to {BULK_LIMIT} at a time.</span>
      )}
      {pipeline && (
        <Select
          disabled={pending || tooMany}
          value=""
          onValueChange={(stage_id) => update({ stage_id })}
        >
          <SelectTrigger size="sm" className="w-40" aria-label="Move to stage">
            <SelectValue placeholder="Move to stage…" />
          </SelectTrigger>
          <SelectContent>
            {pipeline.stages.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Select
        disabled={pending || tooMany}
        value=""
        onValueChange={(v) => update({ assignee_id: v === "__none" ? null : v })}
      >
        <SelectTrigger size="sm" className="w-40" aria-label="Assign to">
          <SelectValue placeholder="Assign to…" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none">Unassign</SelectItem>
          {bootstrap.users.map((u) => (
            <SelectItem key={u.id} value={u.id}>
              {u.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" disabled={pending || tooMany}>
            Status
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => update({ status: "open" })}>Reopen</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => update({ status: "won" })}>Mark won</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setStatusTarget("lost")}>Mark lost…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setStatusTarget("disqualified")}>
            Disqualify…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        size="sm"
        variant="outline"
        disabled={pending || tooMany}
        onClick={() => setConfirmDelete(true)}
      >
        <Trash2 /> Delete
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Clear selection"
        onClick={onClear}
        className="ms-auto"
      >
        <X />
      </Button>

      <StatusDialog
        key={statusTarget ?? "none"}
        status={statusTarget}
        count={ids.length}
        pending={pending}
        onCancel={() => setStatusTarget(null)}
        onConfirm={(status, reason) => update({ status, reason })}
      />

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {ids.length} enquiries?</DialogTitle>
            <DialogDescription>
              They and their history are removed for good. To keep a record, mark them lost or
              disqualified instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                setConfirmDelete(false);
                run(async () => {
                  const r = await bulkDeleteAction(ids);
                  return r.ok ? { ok: true, message: `${r.deleted} deleted.` } : r;
                }, "Deleted.");
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
