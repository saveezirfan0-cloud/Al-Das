"use client";

import * as React from "react";
import { Loader2, Pencil, Tags } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { MultiSelect } from "@/components/ui/multi-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BULK_EDIT_MAX,
  bulkClearable,
  bulkEditableColumns,
  type PortalTag,
} from "@/lib/portal/bulk-edit";

import { bulkEditPortalRecords, bulkTagPortalRecords, createPortalTagInline } from "./actions";
import { FieldInput } from "./field-input";
import type { PortalBootstrap } from "./types";

type RunResult = { ok: boolean; message?: string; error?: string };

/** Selection bar for a portal list: "Edit N records" (one field) and add/remove tags. Writers only. */
export function PortalBulkBar({
  ids,
  bootstrap,
  tags,
  onTagCreated,
  onClear,
  onDone,
}: {
  ids: string[];
  bootstrap: PortalBootstrap;
  tags: PortalTag[];
  onTagCreated: (tag: PortalTag) => void;
  onClear: () => void;
  onDone: () => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const [editOpen, setEditOpen] = React.useState(false);
  const [tagsOpen, setTagsOpen] = React.useState(false);
  const tooMany = ids.length > BULK_EDIT_MAX;
  const noun = ids.length === 1 ? "record" : "records";

  function run(fn: () => Promise<RunResult>, after?: () => void) {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) {
        toast.success(res.message ?? "Done.");
        after?.();
        onDone();
      } else toast.error(res.error ?? "Something went wrong.");
    });
  }

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="bg-primary/5 dark:bg-primary/10 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm"
    >
      <span className="font-medium" aria-live="polite">
        {ids.length.toLocaleString()} selected
      </span>
      <Button variant="ghost" size="sm" onClick={onClear}>
        Clear
      </Button>
      <span className="bg-border mx-1 h-5 w-px" aria-hidden />
      <Button
        variant="outline"
        size="sm"
        disabled={pending || tooMany}
        onClick={() => setEditOpen(true)}
      >
        <Pencil aria-hidden /> Edit {ids.length.toLocaleString()} {noun}
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={pending || tooMany}
        onClick={() => setTagsOpen(true)}
      >
        <Tags aria-hidden /> Tags
      </Button>
      {pending && (
        <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label="Working" />
      )}
      {tooMany && (
        <span className="text-destructive text-xs">
          Select at most {BULK_EDIT_MAX} records at a time.
        </span>
      )}

      <BulkEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        bootstrap={bootstrap}
        count={ids.length}
        pending={pending}
        onApply={(input) =>
          run(
            () => bulkEditPortalRecords(bootstrap.object.key, { ...input, ids }),
            () => setEditOpen(false),
          )
        }
      />

      <BulkTagDialog
        open={tagsOpen}
        onOpenChange={setTagsOpen}
        tags={tags}
        canCreate={bootstrap.can.manageTags}
        onTagCreated={onTagCreated}
        count={ids.length}
        pending={pending}
        onApply={(add, remove) =>
          run(
            () => bulkTagPortalRecords(bootstrap.object.key, { ids, add, remove }),
            () => setTagsOpen(false),
          )
        }
      />
    </div>
  );
}

type EditInput = { op: "set"; field: string; value: unknown } | { op: "clear"; field: string };

function BulkEditDialog({
  open,
  onOpenChange,
  bootstrap,
  count,
  pending,
  onApply,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  bootstrap: PortalBootstrap;
  count: number;
  pending: boolean;
  onApply: (input: EditInput) => void;
}) {
  const columns = React.useMemo(() => bulkEditableColumns(bootstrap.object), [bootstrap.object]);
  const [field, setField] = React.useState<string>("");
  const [mode, setMode] = React.useState<"set" | "clear">("set");
  const [value, setValue] = React.useState<unknown>(null);

  React.useEffect(() => {
    if (open) {
      setField("");
      setMode("set");
      setValue(null);
    }
  }, [open]);

  const column = columns.find((c) => c.key === field) ?? null;
  // A yes/no field starts at "No" in the checkbox, so that is the value sent unless it is ticked.
  const effective = column?.type === "boolean" ? value === true : value;
  const blank =
    effective === null ||
    effective === undefined ||
    (typeof effective === "string" && effective.trim() === "") ||
    (Array.isArray(effective) && effective.length === 0 && column?.type !== "multi_select");
  const canApply = !!column && (mode === "clear" ? bulkClearable(column) : !blank);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Edit {count.toLocaleString()} {count === 1 ? "record" : "records"}
          </DialogTitle>
          <DialogDescription>
            Choose one field and the value every selected record should get. Records that already
            have it are skipped. Each change shows in the record&apos;s History.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="bulk-field">Field</Label>
            <Select
              value={field}
              onValueChange={(v) => {
                setField(v);
                setMode("set");
                setValue(null);
              }}
            >
              <SelectTrigger id="bulk-field" className="w-full">
                <SelectValue placeholder="Choose a field" />
              </SelectTrigger>
              <SelectContent>
                {columns.map((c) => (
                  <SelectItem key={c.key} value={c.key}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {column && (
            <fieldset className="flex flex-col gap-3">
              <legend className="sr-only">Change</legend>
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex min-h-11 items-center gap-2">
                  <input
                    type="radio"
                    name="bulk-mode"
                    className="accent-primary size-4"
                    checked={mode === "set"}
                    onChange={() => setMode("set")}
                  />
                  Set to a value
                </label>
                <label
                  className={`flex min-h-11 items-center gap-2 ${!bulkClearable(column) ? "text-muted-foreground" : ""}`}
                >
                  <input
                    type="radio"
                    name="bulk-mode"
                    className="accent-primary size-4"
                    disabled={!bulkClearable(column)}
                    checked={mode === "clear"}
                    onChange={() => setMode("clear")}
                  />
                  Clear it
                  {!bulkClearable(column) && (
                    <span className="text-xs">
                      {column.required ? "(required field)" : "(cannot be empty)"}
                    </span>
                  )}
                </label>
              </div>
              {mode === "set" && (
                <div className="grid gap-1.5">
                  <Label htmlFor="bulk-value">{column.label}</Label>
                  <FieldInput
                    id="bulk-value"
                    column={column}
                    value={value}
                    onChange={setValue}
                    linkOptions={bootstrap.linkOptions[column.key]}
                  />
                  {column.description && (
                    <p className="text-muted-foreground text-xs">{column.description}</p>
                  )}
                </div>
              )}
            </fieldset>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!canApply || pending}
            onClick={() =>
              column &&
              onApply(
                mode === "clear"
                  ? { op: "clear", field: column.key }
                  : { op: "set", field: column.key, value: effective },
              )
            }
          >
            {pending && <Loader2 className="animate-spin" aria-hidden />} Apply to{" "}
            {count.toLocaleString()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BulkTagDialog({
  open,
  onOpenChange,
  tags,
  canCreate,
  onTagCreated,
  count,
  pending,
  onApply,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tags: PortalTag[];
  canCreate: boolean;
  onTagCreated: (tag: PortalTag) => void;
  count: number;
  pending: boolean;
  onApply: (add: string[], remove: string[]) => void;
}) {
  const [add, setAdd] = React.useState<string[]>([]);
  const [remove, setRemove] = React.useState<string[]>([]);
  React.useEffect(() => {
    if (open) {
      setAdd([]);
      setRemove([]);
    }
  }, [open]);
  const options = tags.map((t) => ({ value: t.id, label: t.name }));
  const overlap = add.some((t) => remove.includes(t));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Tags on {count.toLocaleString()} {count === 1 ? "record" : "records"}
          </DialogTitle>
          <DialogDescription>
            Add tags to every selected record, remove tags from them, or both.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="bulk-tags-add">Add</Label>
            <MultiSelect
              id="bulk-tags-add"
              options={options}
              value={add}
              onChange={setAdd}
              placeholder="Tags to add…"
              emptyText="No portal tags yet."
              onCreate={
                canCreate
                  ? async (label) => {
                      const res = await createPortalTagInline(label);
                      if (!res.ok) {
                        toast.error(res.error);
                        return null;
                      }
                      onTagCreated(res.data);
                      return res.data.id;
                    }
                  : undefined
              }
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="bulk-tags-remove">Remove</Label>
            <MultiSelect
              id="bulk-tags-remove"
              options={options}
              value={remove}
              onChange={setRemove}
              placeholder="Tags to remove…"
              emptyText="No portal tags yet."
            />
          </div>
          {overlap && (
            <p className="text-destructive text-xs">A tag cannot be added and removed at once.</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={pending || overlap || add.length + remove.length === 0}
            onClick={() => onApply(add, remove)}
          >
            {pending && <Loader2 className="animate-spin" aria-hidden />} Apply to{" "}
            {count.toLocaleString()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
