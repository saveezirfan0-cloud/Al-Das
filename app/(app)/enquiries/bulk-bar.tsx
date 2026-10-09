"use client";

import * as React from "react";
import { Download, Loader2, Pencil, Trash2, UserCog, Layers, Flag } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { EnquiryStatus } from "@/lib/enquiries/constants";
import type { PipelineInfo } from "@/lib/enquiries/server";

import { bulkEnquiries as bulkEnquiriesOnce, removeEnquiries } from "./actions";
import type { ClinicValues } from "./clinic-fields";
import { OptionSelect } from "./option-select";
import { StatusReasonDialog } from "./status-dialog";
import type { EnquiriesBootstrap } from "./types";

type EditField =
  | "source"
  | "channel_id"
  | "location_id"
  | "department_id"
  | "specialist_id"
  | "service_id"
  | "est_value";

const BULK_CHUNK = 1000;

/** The server caps one bulk call at 1,000 enquiries; "select all matching" can be larger, so send it in slices. */
async function bulkEnquiries(ids: string[], input: unknown) {
  let updated = 0;
  let failed = 0;
  for (let i = 0; i < ids.length; i += BULK_CHUNK) {
    const res = await bulkEnquiriesOnce(ids.slice(i, i + BULK_CHUNK), input);
    if (!res.ok) return res;
    updated += res.data.updated;
    failed += res.data.failed;
  }
  return {
    ok: true as const,
    message: failed
      ? `${updated} updated, ${failed} could not be changed.`
      : `${updated} enquir${updated === 1 ? "y" : "ies"} updated.`,
  };
}

export function BulkBar({
  ids,
  pageCount,
  total,
  allSelected,
  onSelectAll,
  onClear,
  bootstrap,
  pipeline,
  onExport,
  onDone,
}: {
  ids: string[];
  pageCount: number;
  total: number;
  allSelected: boolean;
  onSelectAll: () => Promise<void>;
  onClear: () => void;
  bootstrap: EnquiriesBootstrap;
  /** The pipeline being viewed; stage moves need one. */
  pipeline: PipelineInfo | null;
  onExport: () => void;
  onDone: () => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const [reasonFor, setReasonFor] = React.useState<EnquiryStatus | null>(null);
  const [editOpen, setEditOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  function run(
    fn: () => Promise<{ ok: boolean; message?: string; error?: string }>,
    after?: () => void,
  ) {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) {
        toast.success(res.message ?? "Done.");
        after?.();
        onDone();
      } else toast.error(res.error);
    });
  }

  const live = bootstrap.pipelines.filter((p) => !p.archived);

  return (
    <div className="bg-primary/5 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm">
      <span className="font-medium">
        {ids.length.toLocaleString()} selected
        {allSelected && <span className="text-muted-foreground font-normal"> (all matching)</span>}
      </span>
      {!allSelected && ids.length === pageCount && total > pageCount && (
        <Button variant="link" size="sm" className="h-auto p-0" onClick={() => void onSelectAll()}>
          Select all {total.toLocaleString()} matching
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={onClear}>
        Clear
      </Button>
      <span className="bg-border mx-1 h-5 w-px" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={pending}>
            <UserCog /> Assign
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="max-h-80 overflow-y-auto">
          <DropdownMenuItem
            onClick={() => run(() => bulkEnquiries(ids, { type: "assign", assignee_id: null }))}
          >
            Unassign
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {bootstrap.users.map((u) => (
            <DropdownMenuItem
              key={u.id}
              onClick={() => run(() => bulkEnquiries(ids, { type: "assign", assignee_id: u.id }))}
            >
              {u.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={pending}>
            <Layers /> Move
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="max-h-80 overflow-y-auto">
          {pipeline ? (
            <>
              <DropdownMenuLabel>Stage in {pipeline.name}</DropdownMenuLabel>
              {pipeline.stages.map((s) => (
                <DropdownMenuItem
                  key={s.id}
                  onClick={() => run(() => bulkEnquiries(ids, { type: "stage", stage_id: s.id }))}
                >
                  {s.name}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuLabel>To pipeline (first stage)</DropdownMenuLabel>
          {live
            .filter((p) => p.id !== pipeline?.id)
            .map((p) => (
              <DropdownMenuItem
                key={p.id}
                onClick={() =>
                  run(() => bulkEnquiries(ids, { type: "pipeline", pipeline_id: p.id }))
                }
              >
                {p.name}
              </DropdownMenuItem>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={pending}>
            <Flag /> Status
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            onClick={() => run(() => bulkEnquiries(ids, { type: "status", status: "open" }))}
          >
            Reopen
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => run(() => bulkEnquiries(ids, { type: "status", status: "won" }))}
          >
            Mark won
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setReasonFor("lost")}>Mark lost…</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setReasonFor("disqualified")}>
            Disqualify…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button variant="outline" size="sm" disabled={pending} onClick={() => setEditOpen(true)}>
        <Pencil /> Edit fields
      </Button>
      {bootstrap.can.export && (
        <Button variant="outline" size="sm" onClick={onExport}>
          <Download /> Export
        </Button>
      )}
      {bootstrap.can.delete && (
        <Button
          variant="outline"
          size="sm"
          className="text-destructive"
          disabled={pending}
          onClick={() => setDeleteOpen(true)}
        >
          <Trash2 /> Delete
        </Button>
      )}
      {pending && <Loader2 className="text-muted-foreground size-4 animate-spin" />}

      <StatusReasonDialog
        open={!!reasonFor}
        status={reasonFor}
        count={ids.length}
        pending={pending}
        onCancel={() => setReasonFor(null)}
        onConfirm={(reason) =>
          reasonFor &&
          run(
            () => bulkEnquiries(ids, { type: "status", status: reasonFor, reason }),
            () => setReasonFor(null),
          )
        }
      />

      <BulkEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        bootstrap={bootstrap}
        pending={pending}
        onApply={(input) =>
          run(
            () => bulkEnquiries(ids, input),
            () => setEditOpen(false),
          )
        }
      />

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {ids.length.toLocaleString()} enquiries?</DialogTitle>
            <DialogDescription>
              They disappear from every list and board. The audit log keeps a record that they were
              deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() =>
                run(
                  () => removeEnquiries(ids),
                  () => setDeleteOpen(false),
                )
              }
            >
              {pending && <Loader2 className="animate-spin" />} Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BulkEditDialog({
  open,
  onOpenChange,
  bootstrap,
  pending,
  onApply,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  bootstrap: EnquiriesBootstrap;
  pending: boolean;
  onApply: (input: unknown) => void;
}) {
  const [fields, setFields] = React.useState<Set<EditField>>(new Set());
  const [source, setSource] = React.useState<string | null>(null);
  const [channel, setChannel] = React.useState<string | null>(null);
  const [estValue, setEstValue] = React.useState("");
  const [clinic, setClinic] = React.useState<ClinicValues>({
    location_id: null,
    department_id: null,
    specialist_id: null,
    service_id: null,
  });

  React.useEffect(() => {
    if (open) {
      setFields(new Set());
      setSource(null);
      setChannel(null);
      setEstValue("");
      setClinic({ location_id: null, department_id: null, specialist_id: null, service_id: null });
    }
  }, [open]);

  const toggle = (f: EditField, on: boolean) =>
    setFields((prev) => {
      const next = new Set(prev);
      if (on) next.add(f);
      else next.delete(f);
      return next;
    });

  const Row = ({
    field,
    label,
    children,
  }: {
    field: EditField;
    label: string;
    children: React.ReactNode;
  }) => (
    <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1">
      <Checkbox
        id={`be-${field}`}
        checked={fields.has(field)}
        onCheckedChange={(c) => toggle(field, c === true)}
        aria-label={`Change ${label}`}
      />
      <Label htmlFor={`be-${field}`}>{label}</Label>
      <span />
      <div className={fields.has(field) ? "" : "pointer-events-none opacity-50"}>{children}</div>
    </div>
  );

  function apply() {
    onApply({
      type: "edit",
      fields: [...fields],
      source,
      channel_id: channel,
      est_value: estValue.trim() || null,
      ...clinic,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit fields</DialogTitle>
          <DialogDescription>
            Tick the fields to change. Leaving a ticked field empty clears it.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Row field="source" label="Source">
            <OptionSelect
              value={source}
              options={bootstrap.sources.map((s) => ({ value: s, label: s }))}
              onChange={setSource}
            />
          </Row>
          <Row field="channel_id" label="WhatsApp number">
            <OptionSelect
              value={channel}
              options={bootstrap.lookups.channels.map((c) => ({ value: c.id, label: c.name }))}
              onChange={setChannel}
            />
          </Row>
          <Row field="est_value" label="Estimated value">
            <Input
              inputMode="decimal"
              value={estValue}
              onChange={(e) => setEstValue(e.target.value)}
            />
          </Row>
          {(["location_id", "department_id", "specialist_id", "service_id"] as const).map((f) => (
            <Row
              key={f}
              field={f}
              label={
                {
                  location_id: "Location",
                  department_id: "Department",
                  specialist_id: "Specialist",
                  service_id: "Service",
                }[f]
              }
            >
              <OptionSelect
                value={clinic[f]}
                options={{
                  location_id: bootstrap.lookups.locations,
                  department_id: bootstrap.lookups.departments,
                  specialist_id: bootstrap.lookups.specialists,
                  service_id: bootstrap.lookups.services,
                }[f].map((x) => ({ value: x.id, label: x.name }))}
                onChange={(v) => setClinic((c) => ({ ...c, [f]: v }))}
              />
            </Row>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={pending || fields.size === 0} onClick={apply}>
            {pending && <Loader2 className="animate-spin" />} Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
