"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  FilterBuilder,
  type ClientField,
  type OptionSources,
} from "@/components/filter-builder/filter-builder";
import { Button } from "@/components/ui/button";
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
import { Switch } from "@/components/ui/switch";
import type { SegmentSummary } from "@/lib/contacts/server";
import {
  countConditions,
  emptyGroup,
  emptyFilter,
  isEmptyFilter,
  safeParseFilter,
  type Filter,
} from "@/lib/filters/ast";

import { clinicalFieldsIn } from "@/lib/campaigns/audience-purpose";

import { saveSegment } from "./actions";

export function SegmentDialog({
  open,
  onOpenChange,
  segment,
  initialFilter,
  fields,
  options,
  dripFlows,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  segment?: SegmentSummary;
  initialFilter: Filter | null;
  fields: ClientField[];
  options: OptionSources;
  /** Flows that can run as this segment's drip (null = the person may not choose one). */
  dripFlows?: Array<{ id: string; name: string; active: boolean }> | null;
  onSaved: (segment: SegmentSummary) => void;
}) {
  const [name, setName] = React.useState("");
  const [kind, setKind] = React.useState<"static" | "dynamic">("static");
  const [filter, setFilter] = React.useState<Filter>(emptyFilter());
  const [excluding, setExcluding] = React.useState(false);
  const [dripFlowId, setDripFlowId] = React.useState<string | null>(null);
  const [careOnly, setCareOnly] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (!open) return;
    const existing = segment ? safeParseFilter(segment.filter) : null;
    const f = existing ?? initialFilter ?? emptyFilter();
    setName(segment?.name ?? "");
    setKind(
      segment ? (segment.kind as "static" | "dynamic") : initialFilter ? "dynamic" : "static",
    );
    setFilter(f);
    setExcluding(!!f.exclude && countConditions(f.exclude) > 0);
    setDripFlowId(segment?.drip_flow_id ?? null);
    setCareOnly(segment?.care_only ?? false);
  }, [open, segment, initialFilter]);

  // Care programmes only: a filter with a clinical field can never build a marketing audience (enforced on the server).
  const clinicalUsed = React.useMemo(
    () =>
      kind === "dynamic" &&
      clinicalFieldsIn(filter, {
        get: (key) => {
          const f = fields.find((x) => x.key === key);
          return f ? { clinical: f.clinical === true, careOnly: f.careOnly === true } : undefined;
        },
      }).length > 0,
    [kind, filter, fields],
  );

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const effective: Filter = {
      include: filter.include,
      exclude: excluding ? (filter.exclude ?? emptyGroup("and")) : null,
    };
    if (kind === "dynamic" && isEmptyFilter(effective)) {
      toast.error("Add at least one condition.");
      return;
    }
    startTransition(async () => {
      const res = await saveSegment(segment?.id ?? null, {
        name,
        kind,
        filter: kind === "dynamic" ? effective : null,
        // Only sent when the person may choose it; the server re-checks flows.manage.
        ...(dripFlows ? { drip_flow_id: kind === "static" ? dripFlowId : null } : {}),
        ...(kind === "static" ? { care_only: careOnly } : {}),
      });
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
        care_only: kind === "static" ? careOnly : clinicalUsed || (segment?.care_only ?? false),
        drip_flow_id: dripFlows
          ? kind === "static"
            ? dripFlowId
            : null
          : (segment?.drip_flow_id ?? null),
      });
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{segment ? `Edit ${segment.name}` : "New segment"}</DialogTitle>
          <DialogDescription>
            Static segments are hand-picked lists. Dynamic segments re-evaluate a saved filter every
            time.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="segment-name">Name</Label>
            <Input
              id="segment-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="e.g. Dermatology follow-ups"
            />
          </div>
          <div className="grid gap-2">
            <Label>Type</Label>
            <Select
              value={kind}
              onValueChange={(v) => setKind(v as "static" | "dynamic")}
              disabled={!!segment}
            >
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
                <FilterBuilder
                  group={filter.include}
                  onChange={(g) => setFilter({ ...filter, include: g })}
                  fields={fields}
                  options={options}
                />
              </div>
              {clinicalUsed && (
                <p
                  role="note"
                  className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
                >
                  Care programmes only (recall and follow-up), not marketing.
                </p>
              )}
              <label className="flex items-center justify-between text-sm font-medium">
                Exclusion filters
                <Switch checked={excluding} onCheckedChange={setExcluding} />
              </label>
              {excluding && (
                <FilterBuilder
                  group={filter.exclude ?? emptyGroup("and")}
                  onChange={(g) => setFilter({ ...filter, exclude: g })}
                  fields={fields}
                  options={options}
                />
              )}
            </>
          )}
          {kind === "static" && !segment && (
            <p className="text-muted-foreground text-sm">
              Add contacts from the grid with the bulk action &ldquo;Add to segment&rdquo;.
            </p>
          )}
          {kind === "static" && (
            <label className="flex items-start justify-between gap-4 text-sm">
              <span className="grid gap-0.5">
                <span className="font-medium">Care programmes only</span>
                <span className="text-muted-foreground text-xs">
                  Use this list for recall and follow-up, never for a marketing campaign. Switched
                  on automatically when the list is filled from a filter that uses health
                  information. Only an administrator can switch it off again.
                </span>
              </span>
              <Switch
                checked={careOnly}
                onCheckedChange={setCareOnly}
                aria-label="Care programmes only"
              />
            </label>
          )}
          {kind === "static" && dripFlows && (
            <div className="grid gap-2">
              <Label>Drip flow</Label>
              <Select
                value={dripFlowId ?? "none"}
                onValueChange={(v) => setDripFlowId(v === "none" ? null : v)}
              >
                <SelectTrigger className="w-72" aria-label="Drip flow">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No drip flow</SelectItem>
                  {dripFlows.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.active ? f.name : `${f.name} (not published)`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                Starts the flow once for each contact added from now on (not for those already in
                it). Only flows that start with &ldquo;Contact added to a segment (drip)&rdquo; are
                listed, and only published ones run.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}{" "}
              {segment ? "Save" : "Create segment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
