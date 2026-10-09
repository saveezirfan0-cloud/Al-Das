"use client";

import * as React from "react";
import { Braces, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { CONDITION_FIELDS } from "@/lib/flow-engine/conditions";
import {
  BUTTON_TITLE_MAX,
  MAX_BUTTONS,
  MAX_LIST_ROWS,
  ROW_TITLE_MAX,
  type FlowOption,
} from "@/lib/flow-engine/types";
import type { Condition, Filter, Group, Operator } from "@/lib/filters/ast";
import { emptyGroup } from "@/lib/filters/ast";
import type { Weekday } from "@/lib/flow-engine/types";

export const INSERTABLE = [
  [
    "Contact",
    [
      ["contact.first_name", "First name"],
      ["contact.last_name", "Last name"],
      ["contact.full_name", "Full name"],
      ["contact.email", "E-mail"],
      ["contact.phone_e164", "Phone"],
    ],
  ],
  [
    "Message",
    [
      ["message.text", "Last message text"],
      ["message.button_title", "Button tapped"],
    ],
  ],
  [
    "Appointment",
    [
      ['appointment.starts_at|date:"DD MMM HH:mm"', "Date and time"],
      ["appointment.doctor", "Doctor"],
      ["appointment.location", "Location"],
      ["appointment.service", "Service"],
      ["appointment.number", "Number"],
    ],
  ],
  [
    "Enquiry",
    [
      ["enquiry.number", "Number"],
      ["enquiry.title", "Title"],
      ["enquiry.stage", "Stage"],
    ],
  ],
  [
    "Other",
    [
      ["event.body.", "Webhook body field…"],
      ["vars.", "Variable…"],
      ["steps.", "Earlier step result…"],
    ],
  ],
] as const;

export function InsertField({ onInsert }: { onInsert: (token: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-xs">
          <Braces className="size-3" />
          Insert field
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
        {INSERTABLE.map(([group, items], i) => (
          <React.Fragment key={group}>
            {i > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel className="text-xs">{group}</DropdownMenuLabel>
            {items.map(([token, label]) => (
              <DropdownMenuItem key={token} onSelect={() => onInsert(`{${token}}`)}>
                {label}
              </DropdownMenuItem>
            ))}
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TextField({
  label,
  value,
  onChange,
  multiline,
  max,
  placeholder,
  help,
  interpolate,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  max?: number;
  placeholder?: string;
  help?: string;
  interpolate?: boolean;
  mono?: boolean;
}) {
  const id = React.useId();
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor={id}>{label}</Label>
        {interpolate ? <InsertField onInsert={(t) => onChange(`${value}${t}`)} /> : null}
      </div>
      {multiline ? (
        <Textarea
          id={id}
          value={value}
          maxLength={max}
          rows={4}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={mono ? "font-mono text-xs" : undefined}
        />
      ) : (
        <Input
          id={id}
          value={value}
          maxLength={max}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={mono ? "font-mono text-xs" : undefined}
        />
      )}
      {help ? <p className="text-muted-foreground text-xs">{help}</p> : null}
      {max && multiline ? (
        <p className="text-muted-foreground text-right text-[11px]">
          {value.length}/{max}
        </p>
      ) : null}
    </div>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  help,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  min?: number;
  max?: number;
  help?: string;
}) {
  const id = React.useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
      />
      {help ? <p className="text-muted-foreground text-xs">{help}</p> : null}
    </div>
  );
}

const NONE = "__none__";
export function SelectField({
  label,
  value,
  onChange,
  options,
  allowNone,
  noneLabel = "Not set",
  help,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  options: Array<{ value: string; label: string }>;
  allowNone?: boolean;
  noneLabel?: string;
  help?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select
        value={value ?? (allowNone ? NONE : "")}
        onValueChange={(v) => onChange(v === NONE ? undefined : v)}
      >
        <SelectTrigger>
          <SelectValue placeholder="Choose…" />
        </SelectTrigger>
        <SelectContent>
          {allowNone ? <SelectItem value={NONE}>{noneLabel}</SelectItem> : null}
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {help ? <p className="text-muted-foreground text-xs">{help}</p> : null}
    </div>
  );
}

/** key → value pairs (template values, headers, portal fields). */
export function KeyValueEditor({
  label,
  value,
  onChange,
  keyLabel = "Name",
  valueLabel = "Value",
  keyOptions,
  interpolate = true,
}: {
  label: string;
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  keyLabel?: string;
  valueLabel?: string;
  keyOptions?: string[];
  interpolate?: boolean;
}) {
  const rows = Object.entries(value);
  const set = (next: Array<[string, string]>) =>
    onChange(Object.fromEntries(next.filter(([k]) => k !== "")));
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-xs"
          onClick={() => onChange({ ...value, [nextKey(value, keyOptions)]: "" })}
        >
          <Plus className="size-3" />
          Add
        </Button>
      </div>
      {rows.length === 0 ? <p className="text-muted-foreground text-xs">None.</p> : null}
      {rows.map(([k, v], i) => (
        <div key={i} className="grid grid-cols-[1fr_1.4fr_auto] items-start gap-1.5">
          <Input
            aria-label={keyLabel}
            value={k}
            className="font-mono text-xs"
            onChange={(e) =>
              set(rows.map(([kk, vv], j) => (j === i ? [e.target.value, vv] : [kk, vv])))
            }
          />
          <div className="space-y-0.5">
            <Input
              aria-label={valueLabel}
              value={v}
              onChange={(e) =>
                set(rows.map(([kk, vv], j) => (j === i ? [kk, e.target.value] : [kk, vv])))
              }
            />
            {interpolate ? (
              <InsertField
                onInsert={(t) =>
                  set(rows.map(([kk, vv], j) => (j === i ? [kk, `${vv}${t}`] : [kk, vv])))
                }
              />
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Remove"
            onClick={() => set(rows.filter((_, j) => j !== i))}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
    </div>
  );
}

function nextKey(existing: Record<string, string>, options?: string[]): string {
  const taken = new Set(Object.keys(existing));
  if (options) return options.find((o) => !taken.has(o)) ?? `field_${taken.size + 1}`;
  let i = taken.size + 1;
  while (taken.has(`key_${i}`)) i++;
  return `key_${i}`;
}

/** Buttons / list rows. */
export function OptionsEditor({
  options,
  onChange,
  kind,
}: {
  options: FlowOption[];
  onChange: (v: FlowOption[]) => void;
  kind: "buttons" | "list";
}) {
  const max = kind === "buttons" ? MAX_BUTTONS : MAX_LIST_ROWS;
  const titleMax = kind === "buttons" ? BUTTON_TITLE_MAX : ROW_TITLE_MAX;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label>
          {kind === "buttons"
            ? `Buttons (up to ${MAX_BUTTONS})`
            : `List rows (up to ${MAX_LIST_ROWS})`}
        </Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-xs"
          disabled={options.length >= max}
          onClick={() => onChange([...options, { id: uniqueId(options), title: "" }])}
        >
          <Plus className="size-3" />
          Add
        </Button>
      </div>
      {options.map((o, i) => (
        <div key={o.id} className="grid grid-cols-[1fr_auto] items-center gap-1.5">
          <div className="space-y-0.5">
            <Input
              aria-label={`Option ${i + 1} text`}
              value={o.title}
              maxLength={titleMax}
              placeholder="Text the patient sees"
              onChange={(e) =>
                onChange(options.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))
              }
            />
            <div className="text-muted-foreground flex items-center justify-between text-[11px]">
              <span className="font-mono">option:{o.id}</span>
              <span>
                {o.title.length}/{titleMax}
              </span>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={`Remove option ${i + 1}`}
            onClick={() => onChange(options.filter((_, j) => j !== i))}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
    </div>
  );
}

function uniqueId(options: FlowOption[]): string {
  const taken = new Set(options.map((o) => o.id));
  let i = options.length + 1;
  while (taken.has(`opt${i}`)) i++;
  return `opt${i}`;
}

// ---------------------------------------------------------------------------
// Conditions (flat AND/OR list; the stored shape is the shared filter AST)
// ---------------------------------------------------------------------------

const OPS: Array<{ op: Operator; label: string; unary?: boolean }> = [
  { op: "eq", label: "is" },
  { op: "neq", label: "is not" },
  { op: "contains", label: "contains" },
  { op: "not_contains", label: "does not contain" },
  { op: "starts_with", label: "starts with" },
  { op: "in", label: "is one of (comma separated)" },
  { op: "not_in", label: "is none of" },
  { op: "is_empty", label: "is empty", unary: true },
  { op: "is_not_empty", label: "is not empty", unary: true },
  { op: "gt", label: "greater than" },
  { op: "lt", label: "less than" },
  { op: "is_true", label: "is yes", unary: true },
  { op: "is_false", label: "is no", unary: true },
];

export function ConditionsEditor({
  value,
  onChange,
  title = "Conditions",
}: {
  value: Filter | null | undefined;
  onChange: (v: Filter | null) => void;
  title?: string;
}) {
  const include: Group = value?.include ?? emptyGroup("and");
  const rows = include.children.filter((c): c is Condition => c.type === "condition");
  const write = (next: Condition[], logic = include.logic) =>
    onChange(
      next.length
        ? { include: { type: "group", logic, children: next }, exclude: value?.exclude ?? null }
        : null,
    );
  const fieldOptions = [...CONDITION_FIELDS.map((f) => f.key), "vars."];
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{title}</Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-xs"
          onClick={() =>
            write([
              ...rows,
              { type: "condition", field: "message.text", op: "contains", value: "" },
            ])
          }
        >
          <Plus className="size-3" />
          Add condition
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-xs">No conditions: always matches.</p>
      ) : null}
      {rows.length > 1 ? (
        <Select value={include.logic} onValueChange={(v) => write(rows, v as "and" | "or")}>
          <SelectTrigger className="h-8 w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="and">All of these</SelectItem>
            <SelectItem value="or">Any of these</SelectItem>
          </SelectContent>
        </Select>
      ) : null}
      {rows.map((r, i) => {
        const def = OPS.find((o) => o.op === r.op);
        const known = CONDITION_FIELDS.some((f) => f.key === r.field);
        return (
          <div key={i} className="space-y-1 rounded-md border p-2">
            <div className="flex items-center gap-1.5">
              <Select
                value={known ? r.field : "__custom__"}
                onValueChange={(v) =>
                  write(
                    rows.map((x, j) =>
                      j === i ? { ...x, field: v === "__custom__" ? "vars.name" : v } : x,
                    ),
                  )
                }
              >
                <SelectTrigger className="h-8 flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONDITION_FIELDS.map((f) => (
                    <SelectItem key={f.key} value={f.key}>
                      {f.label}
                    </SelectItem>
                  ))}
                  <SelectItem value="__custom__">A variable…</SelectItem>
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label="Remove condition"
                onClick={() => write(rows.filter((_, j) => j !== i))}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            {!known ? (
              <Input
                aria-label="Field path"
                value={r.field}
                className="h-8 font-mono text-xs"
                list="flow-field-paths"
                onChange={(e) =>
                  write(
                    rows.map((x, j) =>
                      j === i
                        ? { ...x, field: e.target.value.toLowerCase().replace(/[^a-z0-9_.]/g, "") }
                        : x,
                    ),
                  )
                }
              />
            ) : null}
            <div className="grid grid-cols-2 gap-1.5">
              <Select
                value={r.op}
                onValueChange={(v) =>
                  write(rows.map((x, j) => (j === i ? { ...x, op: v as Operator } : x)))
                }
              >
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OPS.map((o) => (
                    <SelectItem key={o.op} value={o.op}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {def?.unary ? (
                <span />
              ) : (
                <Input
                  aria-label="Value"
                  className="h-8"
                  value={String(r.value ?? "")}
                  onChange={(e) =>
                    write(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
                  }
                />
              )}
            </div>
          </div>
        );
      })}
      <datalist id="flow-field-paths">
        {fieldOptions.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Office hours
// ---------------------------------------------------------------------------

export const WEEKDAYS: Array<{ key: Weekday; label: string }> = [
  { key: "mon", label: "Monday" },
  { key: "tue", label: "Tuesday" },
  { key: "wed", label: "Wednesday" },
  { key: "thu", label: "Thursday" },
  { key: "fri", label: "Friday" },
  { key: "sat", label: "Saturday" },
  { key: "sun", label: "Sunday" },
];

export function ScheduleEditor({
  value,
  onChange,
}: {
  value: Partial<Record<Weekday, Array<{ from: string; to: string }>>>;
  onChange: (v: Partial<Record<Weekday, Array<{ from: string; to: string }>>>) => void;
}) {
  const setDay = (d: Weekday, windows: Array<{ from: string; to: string }>) => {
    const next = { ...value };
    if (windows.length) next[d] = windows;
    else delete next[d];
    onChange(next);
  };
  return (
    <div className="space-y-1.5">
      <Label>Opening hours</Label>
      {WEEKDAYS.map((d) => {
        const windows = value[d.key] ?? [];
        return (
          <div key={d.key} className="flex items-start gap-2">
            <span className="w-20 pt-1.5 text-sm">{d.label.slice(0, 3)}</span>
            <div className="flex-1 space-y-1">
              {windows.length === 0 ? (
                <span className="text-muted-foreground text-xs leading-8">Closed</span>
              ) : null}
              {windows.map((w, i) => (
                <div key={i} className="flex items-center gap-1">
                  <Input
                    type="time"
                    aria-label={`${d.label} opens`}
                    value={w.from}
                    className="h-8"
                    onChange={(e) =>
                      setDay(
                        d.key,
                        windows.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)),
                      )
                    }
                  />
                  <span>–</span>
                  <Input
                    type="time"
                    aria-label={`${d.label} closes`}
                    value={w.to}
                    className="h-8"
                    onChange={(e) =>
                      setDay(
                        d.key,
                        windows.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)),
                      )
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    aria-label="Remove window"
                    onClick={() =>
                      setDay(
                        d.key,
                        windows.filter((_, j) => j !== i),
                      )
                    }
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={`Add hours on ${d.label}`}
              onClick={() => setDay(d.key, [...windows, { from: "09:00", to: "18:00" }])}
            >
              <Plus className="size-3.5" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
