"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { FilterBuilder, type ClientField, type OptionSources } from "@/components/filter-builder/filter-builder";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { SegmentSummary } from "@/lib/contacts/server";
import { countConditions, emptyGroup, emptyFilter, isEmptyFilter, safeParseFilter, type Filter } from "@/lib/filters/ast";

import { saveSegment } from "./actions";

export function SegmentDialog({
  open,
  onOpenChange,
  segment,
  initialFilter,
  fields,
  options,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  segment?: SegmentSummary;
  initialFilter: Filter | null;
  fields: ClientField[];
  options: OptionSources;
  onSaved: (segment: SegmentSummary) => void;
}) {
  const [name, setName] = React.useState("");
  const [kind, setKind] = React.useState<"static" | "dynamic">("static");
  const [filter, setFilter] = React.useState<Filter>(emptyFilter());
  const [excluding, setExcluding] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (!open) return;
    const existing = segment ? safeParseFilter(segment.filter) : null;
    const f = existing ?? initialFilter ?? emptyFilter();
    setName(segment?.name ?? "");
    setKind(segment ? (segment.kind as "static" | "dynamic") : initialFilter ? "dynamic" : "static");
    setFilter(f);
    setExcluding(!!f.exclude && countConditions(f.exclude) > 0);
  }, [open, segment, initialFilter]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const effective: Filter = { include: filter.include, exclude: excluding ? (filter.exclude ?? emptyGroup("and")) : null };
    if (kind === "dynamic" && isEmptyFilter(effective)) {
      toast.error("Add at least one condition.");
      return;
    }
    startTransition(async () => {
      const res = await saveSegment(segment?.id ?? null, { name, kind, filter: kind === "dynamic" ? effective : null });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message);
      onSaved({
        id: res.data.id,
        name,
        kind,
        filter: kind === "dynamic" ? effective : null,
        member_count: segment?.member_count ?? 0,
        count_refreshed_at: new Date().toISOString(),
      });
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{segment ? `Edit ${segment.name}` : "New segment"}</DialogTitle>
          <DialogDescription>Static segments are hand-picked lists. Dynamic segments re-evaluate a saved filter every time.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="segment-name">Name</Label>
            <Input id="segment-name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Dermatology follow-ups" />
          </div>
          <div className="grid gap-2">
            <Label>Type</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as "static" | "dynamic")} disabled={!!segment}>
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="static">Static (hand-picked)</SelectItem>
                <SelectItem value="dynamic">Dynamic (saved filter)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {kind === "dynamic" && (
            <>
              <div className="grid gap-2">
                <Label>Include contacts where</Label>
                <FilterBuilder group={filter.include} onChange={(g) => setFilter({ ...filter, include: g })} fields={fields} options={options} />
              </div>
              <label className="flex items-center justify-between text-sm font-medium">
                Exclusion filters
                <Switch checked={excluding} onCheckedChange={setExcluding} />
              </label>
              {excluding && <FilterBuilder group={filter.exclude ?? emptyGroup("and")} onChange={(g) => setFilter({ ...filter, exclude: g })} fields={fields} options={options} />}
            </>
          )}
          {kind === "static" && !segment && <p className="text-muted-foreground text-sm">Add contacts from the grid with the bulk action &ldquo;Add to segment&rdquo;.</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} {segment ? "Save" : "Create segment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
