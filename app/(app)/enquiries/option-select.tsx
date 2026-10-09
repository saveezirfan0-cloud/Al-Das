"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const NONE = "__none__";

/** Single-select over {value,label} options with an optional "none" entry. */
export function OptionSelect({
  value,
  onChange,
  options,
  placeholder = "—",
  noneLabel = "—",
  allowNone = true,
  disabled,
  id,
  className,
}: {
  value: string | null | undefined;
  onChange: (v: string | null) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
  noneLabel?: string;
  allowNone?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  return (
    <Select
      value={value || NONE}
      onValueChange={(v) => onChange(v === NONE ? null : v)}
      disabled={disabled}
    >
      <SelectTrigger id={id} className={className ?? "w-full"}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {allowNone && <SelectItem value={NONE}>{noneLabel}</SelectItem>}
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
