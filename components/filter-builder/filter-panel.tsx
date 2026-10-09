"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";

import {
  FilterBuilder,
  type ClientField,
  type OptionSources,
} from "@/components/filter-builder/filter-builder";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import {
  countConditions,
  emptyGroup,
  emptyFilter,
  isEmptyFilter,
  type Filter,
} from "@/lib/filters/ast";

export function FilterPanel({
  open,
  onOpenChange,
  value,
  onApply,
  fields,
  options,
  previewCount,
  onSaveAsSegment,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  value: Filter | null;
  onApply: (f: Filter | null) => void;
  fields: ClientField[];
  options: OptionSources;
  /** Returns the number of contacts matching a draft filter, or null on error (with a message). */
  previewCount?: (f: Filter) => Promise<{ count: number } | { error: string }>;
  onSaveAsSegment?: (f: Filter) => void;
}) {
  const [draft, setDraft] = React.useState<Filter>(value ?? emptyFilter());
  const [excluding, setExcluding] = React.useState(
    !!value?.exclude && countConditions(value.exclude) > 0,
  );
  const [preview, setPreview] = React.useState<{ count: number } | { error: string } | null>(null);
  const [previewing, setPreviewing] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setDraft(value ?? emptyFilter());
      setExcluding(!!value?.exclude && countConditions(value.exclude) > 0);
      setPreview(null);
    }
  }, [open, value]);

  const effective: Filter = {
    include: draft.include,
    exclude: excluding ? (draft.exclude ?? emptyGroup("and")) : null,
  };

  React.useEffect(() => {
    if (!open || !previewCount) return;
    if (isEmptyFilter(effective)) {
      setPreview(null);
      return;
    }
    const handle = setTimeout(() => {
      setPreviewing(true);
      previewCount(effective)
        .then(setPreview)
        .finally(() => setPreviewing(false));
    }, 400);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(effective), open]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Filter contacts</SheetTitle>
          <SheetDescription>
            Combine conditions with AND / OR groups. Exclusion filters remove matches from the
            result.
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4">
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Include contacts where</h3>
            <FilterBuilder
              group={draft.include}
              onChange={(g) => setDraft({ ...draft, include: g })}
              fields={fields}
              options={options}
            />
          </section>
          <section className="flex flex-col gap-2">
            <label className="flex items-center justify-between text-sm font-medium">
              Exclusion filters
              <Switch
                checked={excluding}
                onCheckedChange={setExcluding}
                aria-label="Enable exclusion filters"
              />
            </label>
            {excluding && (
              <FilterBuilder
                group={draft.exclude ?? emptyGroup("and")}
                onChange={(g) => setDraft({ ...draft, exclude: g })}
                fields={fields}
                options={options}
              />
            )}
          </section>
          {previewCount && (
            <p className="text-muted-foreground text-xs" aria-live="polite">
              {previewing ? (
                <span className="inline-flex items-center gap-1">
                  <Loader2 className="size-3 animate-spin" /> Counting…
                </span>
              ) : preview && "error" in preview ? (
                <span className="text-destructive">{preview.error}</span>
              ) : preview ? (
                `${preview.count.toLocaleString()} matching contacts`
              ) : (
                "Add a condition to preview the count."
              )}
            </p>
          )}
        </div>
        <SheetFooter className="flex-row justify-between gap-2 border-t">
          <Button
            variant="ghost"
            onClick={() => {
              setDraft(emptyFilter());
              setExcluding(false);
              onApply(null);
              onOpenChange(false);
            }}
          >
            Clear
          </Button>
          <div className="flex gap-2">
            {onSaveAsSegment && (
              <Button
                variant="outline"
                disabled={isEmptyFilter(effective)}
                onClick={() => onSaveAsSegment(effective)}
              >
                Save as segment
              </Button>
            )}
            <Button
              onClick={() => {
                onApply(isEmptyFilter(effective) ? null : effective);
                onOpenChange(false);
              }}
            >
              Apply
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
