"use client";

import { Filter as FilterIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelect } from "@/components/ui/multi-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { EnquiryFilter } from "@/lib/enquiries/filter";
import type { PipelineView } from "@/lib/enquiries/types";

import type { EnquiriesBootstrap } from "./types";

type ListKey =
  | "stage_ids"
  | "assignees"
  | "sources"
  | "channel_ids"
  | "location_ids"
  | "department_ids"
  | "specialist_ids"
  | "service_ids";

const DATE_KEYS = ["created_from", "created_to", "closed_from", "closed_to"] as const;

/** Number of narrowing filters set (pipeline, Open/Closed switch and search are shown elsewhere). */
export function activeFilterCount(f: EnquiryFilter): number {
  const lists: ListKey[] = [
    "stage_ids",
    "assignees",
    "sources",
    "channel_ids",
    "location_ids",
    "department_ids",
    "specialist_ids",
    "service_ids",
  ];
  return (
    lists.filter((k) => (f[k]?.length ?? 0) > 0).length +
    DATE_KEYS.filter((k) => !!f[k]).length +
    (f.status?.length ? 1 : 0)
  );
}

export function FilterPopover({
  bootstrap,
  pipeline,
  filter,
  onChange,
}: {
  bootstrap: EnquiriesBootstrap;
  pipeline: PipelineView | undefined;
  filter: EnquiryFilter;
  onChange: (next: EnquiryFilter) => void;
}) {
  const count = activeFilterCount(filter);
  const opts = (items: Array<{ id: string; name: string }>) =>
    items.map((i) => ({ value: i.id, label: i.name }));

  function list(key: ListKey, label: string, options: Array<{ value: string; label: string }>) {
    return (
      <div className="flex flex-col gap-1">
        <Label className="text-xs">{label}</Label>
        <MultiSelect
          options={options}
          value={(filter[key] as string[] | undefined) ?? []}
          onChange={(v) => onChange({ ...filter, [key]: v.length ? v : undefined })}
          placeholder="Any"
        />
      </div>
    );
  }

  const dates = (
    from: (typeof DATE_KEYS)[number],
    to: (typeof DATE_KEYS)[number],
    label: string,
  ) => (
    <div className="flex flex-col gap-1">
      <Label className="text-xs">{label}</Label>
      <div className="grid grid-cols-2 gap-2">
        <Input
          type="date"
          aria-label={`${label} from`}
          value={filter[from] ?? ""}
          onChange={(e) => onChange({ ...filter, [from]: e.target.value || undefined })}
        />
        <Input
          type="date"
          aria-label={`${label} to`}
          value={filter[to] ?? ""}
          onChange={(e) => onChange({ ...filter, [to]: e.target.value || undefined })}
        />
      </div>
    </div>
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <FilterIcon /> Filters
          {count > 0 && <Badge variant="secondary">{count}</Badge>}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex max-h-[70vh] w-96 flex-col gap-3 overflow-y-auto"
      >
        {pipeline &&
          list(
            "stage_ids",
            "Stage",
            pipeline.stages.map((s) => ({ value: s.id, label: s.name })),
          )}
        {list("assignees", "Assigned to", [
          { value: "me", label: "Me" },
          { value: "unassigned", label: "Unassigned" },
          ...bootstrap.users.map((u) => ({ value: u.id, label: u.label })),
        ])}
        {list(
          "sources",
          "Source",
          bootstrap.sources.map((s) => ({ value: s, label: s })),
        )}
        {list("channel_ids", "Channel", opts(bootstrap.channels))}
        {list("location_ids", "Location", opts(bootstrap.locations))}
        {list("department_ids", "Department", opts(bootstrap.departments))}
        {list("specialist_ids", "Specialist", opts(bootstrap.specialists))}
        {list("service_ids", "Service", opts(bootstrap.services))}
        {dates("created_from", "created_to", "Created")}
        {filter.scope !== "open" && dates("closed_from", "closed_to", "Closed")}
        <Button
          variant="ghost"
          size="sm"
          className="self-end"
          disabled={count === 0}
          onClick={() =>
            onChange({
              pipeline_id: filter.pipeline_id,
              scope: filter.scope,
              search: filter.search,
            })
          }
        >
          Clear filters
        </Button>
      </PopoverContent>
    </Popover>
  );
}
