"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { MultiSelect } from "@/components/ui/multi-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { PortalColumn } from "@/lib/portal/types";

const CLEAR = "__clear__";

/** Typed input for one portal column. Emits the raw value; the server validates with Zod. */
export function FieldInput({
  column,
  value,
  onChange,
  linkOptions,
  disabled,
  id,
}: {
  column: PortalColumn;
  value: unknown;
  onChange: (v: unknown) => void;
  linkOptions?: Array<{ value: string; label: string }>;
  disabled?: boolean;
  id?: string;
}) {
  switch (column.type) {
    case "boolean":
      return (
        <label className="flex h-9 items-center gap-2 text-sm">
          <Checkbox
            id={id}
            checked={value === true}
            disabled={disabled}
            onCheckedChange={(v) => onChange(!!v)}
          />
          {value === true ? "Yes" : "No"}
        </label>
      );
    case "select":
    case "link": {
      const options = column.type === "link" ? (linkOptions ?? []) : (column.options ?? []);
      const current = typeof value === "string" && value ? value : CLEAR;
      // A linked record outside the first page of options must still show up.
      const known = current === CLEAR || options.some((o) => o.value === current);
      return (
        <Select
          value={current}
          disabled={disabled}
          onValueChange={(v) => onChange(v === CLEAR ? null : v)}
        >
          <SelectTrigger id={id} className="w-full">
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            {!column.required && <SelectItem value={CLEAR}>—</SelectItem>}
            {!known && <SelectItem value={current}>{current}</SelectItem>}
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    case "multi_select":
      return column.options ? (
        <MultiSelect
          options={column.options}
          value={Array.isArray(value) ? value.map(String) : []}
          onChange={onChange}
          disabled={disabled}
          placeholder="—"
        />
      ) : (
        <Input
          id={id}
          disabled={disabled}
          placeholder="Comma-separated"
          value={Array.isArray(value) ? value.join(", ") : ""}
          onChange={(e) =>
            onChange(
              e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
        />
      );
    case "number":
      return (
        <Input
          id={id}
          type="number"
          step={column.integer ? 1 : "any"}
          disabled={disabled}
          value={value === null || value === undefined ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      );
    case "date":
      return (
        <Input
          id={id}
          type="date"
          disabled={disabled}
          value={typeof value === "string" ? value.slice(0, 10) : ""}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case "datetime":
      return (
        <Input
          id={id}
          type="datetime-local"
          disabled={disabled}
          value={typeof value === "string" ? value.slice(0, 16) : ""}
          onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)}
        />
      );
    case "long_text":
      return (
        <Textarea
          id={id}
          rows={4}
          disabled={disabled}
          maxLength={column.maxLength}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "email":
    case "url":
      return (
        <Input
          id={id}
          type={column.type}
          disabled={disabled}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    default:
      return (
        <Input
          id={id}
          disabled={disabled}
          maxLength={column.maxLength}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}
