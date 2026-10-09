"use client";

import * as React from "react";
import { Loader2, Tag, Trash2, UserCog, Layers, Pencil } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { CustomFieldDef } from "@/lib/contacts/custom-values";
import type { SegmentSummary } from "@/lib/contacts/server";

import {
  bulkSegment,
  bulkTag,
  bulkUpdate,
  createTag,
  deleteContacts,
  type BulkPatch,
} from "./actions";
import { CustomFieldInput } from "./custom-field-input";
import type { TagOption } from "./types";

export function BulkBar({
  ids,
  pageCount,
  total,
  allSelected,
  onSelectAll,
  onClear,
  tags,
  segments,
  users,
  customFields,
  onTagCreated,
  onDone,
}: {
  ids: string[];
  pageCount: number;
  total: number;
  allSelected: boolean;
  onSelectAll: () => Promise<void>;
  onClear: () => void;
  tags: TagOption[];
  segments: SegmentSummary[];
  users: Array<{ id: string; label: string }>;
  customFields: CustomFieldDef[];
  onTagCreated: (t: TagOption) => void;
  onDone: () => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const [editOpen, setEditOpen] = React.useState(false);
  const [newTagOpen, setNewTagOpen] = React.useState(false);
  const [newTag, setNewTag] = React.useState("");

  function run(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) {
        toast.success(res.message ?? "Done.");
        onDone();
      } else toast.error(res.error);
    });
  }

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
            <Tag /> Tags
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="max-h-80 overflow-y-auto">
          <DropdownMenuLabel>Add tag</DropdownMenuLabel>
          {tags.map((t) => (
            <DropdownMenuItem
              key={`add-${t.id}`}
              onClick={() => run(() => bulkTag(ids, t.id, "add"))}
            >
              {t.name}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onClick={() => setNewTagOpen(true)}>+ New tag…</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Remove tag</DropdownMenuLabel>
          {tags.map((t) => (
            <DropdownMenuItem
              key={`rm-${t.id}`}
              onClick={() => run(() => bulkTag(ids, t.id, "remove"))}
            >
              {t.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={pending}>
            <Layers /> Segments
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="max-h-80 overflow-y-auto">
          {segments.length === 0 && (
            <DropdownMenuLabel className="text-muted-foreground font-normal">
              Create a static segment first.
            </DropdownMenuLabel>
          )}
          {segments.length > 0 && <DropdownMenuLabel>Add to segment</DropdownMenuLabel>}
          {segments.map((s) => (
            <DropdownMenuItem
              key={`add-${s.id}`}
              onClick={() => run(() => bulkSegment(ids, s.id, "add"))}
            >
              {s.name}
            </DropdownMenuItem>
          ))}
          {segments.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Remove from segment</DropdownMenuLabel>
              {segments.map((s) => (
                <DropdownMenuItem
                  key={`rm-${s.id}`}
                  onClick={() => run(() => bulkSegment(ids, s.id, "remove"))}
                >
                  {s.name}
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={pending}>
            <UserCog /> Assign
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="max-h-80 overflow-y-auto">
          <DropdownMenuLabel>Set owner</DropdownMenuLabel>
          {users.map((u) => (
            <DropdownMenuItem
              key={`own-${u.id}`}
              onClick={() => run(() => bulkUpdate(ids, { owner_id: u.id }))}
            >
              {u.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onClick={() => run(() => bulkUpdate(ids, { owner_id: null }))}>
            No owner
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Set assignee</DropdownMenuLabel>
          {users.map((u) => (
            <DropdownMenuItem
              key={`as-${u.id}`}
              onClick={() => run(() => bulkUpdate(ids, { assignee_id: u.id }))}
            >
              {u.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onClick={() => run(() => bulkUpdate(ids, { assignee_id: null }))}>
            Unassigned
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button variant="outline" size="sm" disabled={pending} onClick={() => setEditOpen(true)}>
        <Pencil /> Bulk edit
      </Button>

      <Button
        variant="outline"
        size="sm"
        className="text-destructive ml-auto"
        disabled={pending}
        onClick={() => {
          if (
            confirm(
              `Delete ${ids.length} contact${ids.length === 1 ? "" : "s"}? They disappear from lists and campaigns; history is kept.`,
            )
          )
            run(() => deleteContacts(ids));
        }}
      >
        <Trash2 /> Delete
      </Button>
      {pending && <Loader2 className="size-4 animate-spin" />}

      <BulkEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        customFields={customFields}
        onSubmit={(patch) => run(() => bulkUpdate(ids, patch))}
      />

      <Dialog open={newTagOpen} onOpenChange={setNewTagOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New tag</DialogTitle>
            <DialogDescription>
              The tag is created and added to the selected contacts.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            placeholder="Tag name"
            aria-label="Tag name"
          />
          <DialogFooter>
            <Button
              disabled={!newTag.trim() || pending}
              onClick={() =>
                run(async () => {
                  const res = await createTag({ name: newTag.trim() });
                  if (!res.ok) return res;
                  onTagCreated(res.data);
                  setNewTagOpen(false);
                  setNewTag("");
                  return bulkTag(ids, res.data.id, "add");
                })
              }
            >
              Create and add
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
  customFields,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  customFields: CustomFieldDef[];
  onSubmit: (patch: BulkPatch) => void;
}) {
  const [field, setField] = React.useState<string>("promotions_opt_in");
  const [value, setValue] = React.useState<unknown>(true);

  const fieldOptions = [
    { key: "promotions_opt_in", label: "Promotions opt-in" },
    { key: "stop_marketing", label: "Stop marketing" },
    { key: "language", label: "Language" },
    { key: "label", label: "Label" },
    ...customFields.map((f) => ({ key: `custom.${f.key}`, label: f.label })),
  ];
  const custom = field.startsWith("custom.")
    ? customFields.find((f) => f.key === field.slice(7))
    : null;

  function submit() {
    let patch: BulkPatch;
    if (custom) patch = { custom: { [custom.key]: value === "" ? null : value } };
    else if (field === "promotions_opt_in" || field === "stop_marketing")
      patch = { [field]: value === true || value === "true" } as BulkPatch;
    else patch = { [field]: (value as string) || null } as BulkPatch;
    onSubmit(patch);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Bulk edit</DialogTitle>
          <DialogDescription>Set one field on every selected contact.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Field</Label>
            <Select
              value={field}
              onValueChange={(v) => {
                setField(v);
                setValue(v === "promotions_opt_in" || v === "stop_marketing" ? true : "");
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {fieldOptions.map((o) => (
                  <SelectItem key={o.key} value={o.key}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>Value</Label>
            {custom ? (
              <CustomFieldInput def={custom} value={value} onChange={setValue} />
            ) : field === "promotions_opt_in" || field === "stop_marketing" ? (
              <Select value={String(value)} onValueChange={(v) => setValue(v === "true")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">Yes</SelectItem>
                  <SelectItem value="false">No</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={String(value ?? "")}
                onChange={(e) => setValue(e.target.value)}
                placeholder="Leave empty to clear"
              />
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit}>Apply</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
