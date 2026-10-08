"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { MultiSelect } from "@/components/ui/multi-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { CustomFieldDef } from "@/lib/contacts/custom-values";

const CLEAR = "__clear__";

/** Input for one custom field value, by type. Emits the raw value; the server coerces/validates. */
export function CustomFieldInput({
  def,
  value,
  onChange,
  id,
}: {
  def: CustomFieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  id?: string;
}) {
  switch (def.type) {
    case "boolean":
      return (
        <label className="flex h-9 items-center gap-2 text-sm">
          <Checkbox id={id} checked={value === true} onCheckedChange={(v) => onChange(!!v)} /> {value === true ? "Yes" : "No"}
        </label>
      );
    case "select":
      return (
        <Select value={typeof value === "string" && value ? value : CLEAR} onValueChange={(v) => onChange(v === CLEAR ? null : v)}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={CLEAR}>—</SelectItem>
            {def.options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "multi_select":
      return <MultiSelect options={def.options} value={Array.isArray(value) ? value.map(String) : []} onChange={onChange} placeholder="—" />;
    case "number":
      return <Input id={id} type="number" value={value === null || value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />;
    case "date":
      return <Input id={id} type="date" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)} />;
    case "email":
      return <Input id={id} type="email" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />;
    case "url":
      return <Input id={id} type="url" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />;
    default:
      return <Input id={id} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />;
  }
}
