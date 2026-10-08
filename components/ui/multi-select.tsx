"use client";

import * as React from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

export type MultiSelectOption = { value: string; label: string; hint?: string };

/** Popover checklist with search. Used for tags, segments, users, multi-select custom fields. */
export function MultiSelect({
  options,
  value,
  onChange,
  placeholder = "Select…",
  emptyText = "No options",
  className,
  disabled,
  onCreate,
}: {
  options: MultiSelectOption[];
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  emptyText?: string;
  className?: string;
  disabled?: boolean;
  /** When set, typing a new value shows a "Create" row. */
  onCreate?: (label: string) => Promise<string | null> | string | null;
}) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const selected = options.filter((o) => value.includes(o.value));
  const filtered = options.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase()));
  const canCreate =
    !!onCreate &&
    q.trim() !== "" &&
    !options.some((o) => o.label.toLowerCase() === q.trim().toLowerCase());

  function toggle(v: string) {
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  }

  async function create() {
    if (!onCreate || !canCreate) return;
    setCreating(true);
    try {
      const id = await onCreate(q.trim());
      if (id) {
        onChange([...value, id]);
        setQ("");
      }
    } finally {
      setCreating(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn("h-auto min-h-9 w-full justify-between px-2 py-1 font-normal", className)}
        >
          <span className="flex flex-wrap gap-1">
            {selected.length === 0 && <span className="text-muted-foreground">{placeholder}</span>}
            {selected.slice(0, 4).map((o) => (
              <span
                key={o.value}
                className="bg-secondary text-secondary-foreground inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs"
              >
                {o.label}
                <span
                  role="button"
                  aria-label={`Remove ${o.label}`}
                  className="hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(o.value);
                  }}
                >
                  <X className="size-3" />
                </span>
              </span>
            ))}
            {selected.length > 4 && (
              <span className="text-muted-foreground text-xs">+{selected.length - 4} more</span>
            )}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-56 p-2" align="start">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search…"
          className="mb-2 h-8"
          onKeyDown={(e) => {
            if (e.key === "Enter" && canCreate) {
              e.preventDefault();
              void create();
            }
          }}
        />
        <ScrollArea className="max-h-56">
          <ul className="flex flex-col gap-0.5" role="listbox" aria-multiselectable>
            {filtered.length === 0 && !canCreate && (
              <li className="text-muted-foreground px-2 py-1 text-sm">{emptyText}</li>
            )}
            {filtered.map((o) => {
              const checked = value.includes(o.value);
              return (
                <li key={o.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={checked}
                    onClick={() => toggle(o.value)}
                    className="hover:bg-accent flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm"
                  >
                    <span
                      className={cn(
                        "flex size-4 items-center justify-center rounded border",
                        checked && "bg-primary text-primary-foreground border-primary",
                      )}
                    >
                      {checked && <Check className="size-3" />}
                    </span>
                    <span className="truncate">{o.label}</span>
                    {o.hint && (
                      <span className="text-muted-foreground ml-auto text-xs">{o.hint}</span>
                    )}
                  </button>
                </li>
              );
            })}
            {canCreate && (
              <li>
                <button
                  type="button"
                  disabled={creating}
                  onClick={() => void create()}
                  className="hover:bg-accent text-primary flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm"
                >
                  + Create &ldquo;{q.trim()}&rdquo;
                </button>
              </li>
            )}
          </ul>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
