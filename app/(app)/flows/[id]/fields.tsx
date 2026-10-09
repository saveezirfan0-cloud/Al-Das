"use client";

import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

/** Small form controls for the properties panel. Everything is controlled and works on plain config objects. */

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      {children}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  placeholder,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={mono ? "font-mono text-xs" : undefined}
      />
    </Field>
  );
}

export function AreaField({
  label,
  value,
  onChange,
  hint,
  variables,
  rows = 4,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  variables: string[];
  rows?: number;
}) {
  const tokens = [
    "{contact.first_name}",
    "{contact.last_name}",
    ...variables.map((v) => `{vars.${v}}`),
  ];
  return (
    <Field label={label} hint={hint}>
      <Textarea value={value} onChange={(e) => onChange(e.target.value)} rows={rows} />
      <div className="flex flex-wrap gap-1">
        {tokens.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onChange(`${value}${t}`)}
            className="text-muted-foreground hover:bg-accent rounded border px-1.5 py-0.5 font-mono text-[10px]"
          >
            {t}
          </button>
        ))}
      </div>
    </Field>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  hint,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  min?: number;
  max?: number;
  hint?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        min={min}
        max={max}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
      />
    </Field>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <Select value={value || undefined} onValueChange={onChange}>
        <SelectTrigger aria-label={label}>
          <SelectValue placeholder={placeholder ?? "Choose…"} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

export type Option = { id: string; title: string };

export function OptionsEditor({
  label,
  value,
  onChange,
  max,
  hint,
}: {
  label: string;
  value: Option[];
  onChange: (v: Option[]) => void;
  max: number;
  hint?: string;
}) {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 40) || "option";
  return (
    <Field label={`${label} (${value.length}/${max})`} hint={hint}>
      <div className="flex flex-col gap-1.5">
        {value.map((o, i) => (
          <div key={i} className="flex gap-1.5">
            <Input
              aria-label={`Option ${i + 1}`}
              value={o.title}
              maxLength={24}
              onChange={(e) => {
                const next = [...value];
                // Keep the id stable once edges point at it; only auto-derive while it still matches the old title.
                const autoId = o.id === slug(o.title) || o.id.startsWith("option");
                next[i] = {
                  id: autoId ? uniqueId(slug(e.target.value), value, i) : o.id,
                  title: e.target.value,
                };
                onChange(next);
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove option ${i + 1}`}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
        {value.length < max && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange([...value, { id: uniqueId("option", value, -1), title: "" }])}
          >
            <Plus /> Add
          </Button>
        )}
      </div>
    </Field>
  );
}

function uniqueId(base: string, existing: Option[], skip: number): string {
  let id = base;
  let n = 2;
  while (existing.some((o, i) => i !== skip && o.id === id)) id = `${base}_${n++}`;
  return id;
}

export function KvEditor({
  label,
  value,
  onChange,
  hint,
  keyPlaceholder = "Name",
  valuePlaceholder = "Value",
}: {
  label: string;
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  hint?: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const entries = Object.entries(value);
  return (
    <Field label={label} hint={hint}>
      <div className="flex flex-col gap-1.5">
        {entries.map(([k, v], i) => (
          <div key={i} className="flex gap-1.5">
            <Input
              aria-label={`${label} name ${i + 1}`}
              value={k}
              placeholder={keyPlaceholder}
              className="w-2/5 font-mono text-xs"
              onChange={(e) =>
                onChange(
                  Object.fromEntries(
                    entries.map(([ek, ev], j) => (j === i ? [e.target.value, ev] : [ek, ev])),
                  ),
                )
              }
            />
            <Input
              aria-label={`${label} value ${i + 1}`}
              value={v}
              placeholder={valuePlaceholder}
              onChange={(e) =>
                onChange(
                  Object.fromEntries(
                    entries.map(([ek, ev], j) => (j === i ? [ek, e.target.value] : [ek, ev])),
                  ),
                )
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${label} ${i + 1}`}
              onClick={() => onChange(Object.fromEntries(entries.filter((_, j) => j !== i)))}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange({ ...value, [`key${entries.length + 1}`]: "" })}
        >
          <Plus /> Add
        </Button>
      </div>
    </Field>
  );
}
