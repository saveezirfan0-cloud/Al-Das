"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MultiSelect, type MultiSelectOption } from "@/components/ui/multi-select";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Condition, ConditionValue, FilterNode, Group, Operator } from "@/lib/filters/ast";
import {
  OPERATOR_LABELS,
  OPERATORS_BY_TYPE,
  operatorIsUnary,
  operatorTakesDays,
  operatorTakesList,
  type FieldDef,
} from "@/lib/filters/field-registry";
import { cn } from "@/lib/utils";

/** Serialisable description of a field for the client (no functions). */
export type ClientField = Pick<
  FieldDef,
  "key" | "label" | "group" | "type" | "options" | "optionsSource" | "sortable"
>;

export type OptionSources = Partial<
  Record<NonNullable<FieldDef["optionsSource"]>, MultiSelectOption[]>
>;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function defaultValueFor(field: ClientField, op: Operator): ConditionValue | undefined {
  if (operatorIsUnary(op)) return undefined;
  if (operatorTakesList(op)) return [];
  if (op === "between") return { from: null, to: null };
  if (operatorTakesDays(op)) return 7;
  if (op === "month_is") return 1;
  if (field.type === "number" || field.type === "count") return 0;
  return "";
}

export function FilterBuilder({
  group,
  onChange,
  fields,
  options,
  depth = 0,
}: {
  group: Group;
  onChange: (g: Group) => void;
  fields: ClientField[];
  options: OptionSources;
  depth?: number;
}) {
  const update = (i: number, node: FilterNode) =>
    onChange({ ...group, children: group.children.map((c, j) => (j === i ? node : c)) });
  const remove = (i: number) =>
    onChange({ ...group, children: group.children.filter((_, j) => j !== i) });
  const addCondition = () => {
    const f = fields[0];
    if (!f) return;
    const op = OPERATORS_BY_TYPE[f.type][0];
    const value = defaultValueFor(f, op);
    onChange({
      ...group,
      children: [
        ...group.children,
        value === undefined
          ? { type: "condition", field: f.key, op }
          : { type: "condition", field: f.key, op, value },
      ],
    });
  };
  const addGroup = () =>
    onChange({
      ...group,
      children: [
        ...group.children,
        { type: "group", logic: group.logic === "and" ? "or" : "and", children: [] },
      ],
    });

  return (
    <div className={cn("flex flex-col gap-2 rounded-lg border p-2", depth > 0 && "bg-muted/30")}>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Match</span>
        <Select
          value={group.logic}
          onValueChange={(v) => onChange({ ...group, logic: v as "and" | "or" })}
        >
          <SelectTrigger size="sm" className="h-7 w-24 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="and">all (AND)</SelectItem>
            <SelectItem value="or">any (OR)</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-muted-foreground">of the following</span>
      </div>
      {group.children.map((child, i) =>
        child.type === "condition" ? (
          <ConditionRow
            key={i}
            condition={child}
            fields={fields}
            options={options}
            onChange={(c) => update(i, c)}
            onRemove={() => remove(i)}
          />
        ) : (
          <div key={i} className="flex items-start gap-1">
            <div className="flex-1">
              <FilterBuilder
                group={child}
                onChange={(g) => update(i, g)}
                fields={fields}
                options={options}
                depth={depth + 1}
              />
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Remove group"
              onClick={() => remove(i)}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ),
      )}
      <div className="flex gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={addCondition}
        >
          <Plus className="size-3.5" /> Condition
        </Button>
        {depth < 3 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={addGroup}
          >
            <Plus className="size-3.5" /> Group
          </Button>
        )}
      </div>
    </div>
  );
}

function ConditionRow({
  condition,
  fields,
  options,
  onChange,
  onRemove,
}: {
  condition: Condition;
  fields: ClientField[];
  options: OptionSources;
  onChange: (c: Condition) => void;
  onRemove: () => void;
}) {
  const field = fields.find((f) => f.key === condition.field) ?? fields[0];
  const ops = field ? OPERATORS_BY_TYPE[field.type] : [];
  const groups = [...new Set(fields.map((f) => f.group))];

  function setField(key: string) {
    const f = fields.find((x) => x.key === key);
    if (!f) return;
    const op = OPERATORS_BY_TYPE[f.type].includes(condition.op)
      ? condition.op
      : OPERATORS_BY_TYPE[f.type][0];
    const value = defaultValueFor(f, op);
    onChange(
      value === undefined
        ? { type: "condition", field: key, op }
        : { type: "condition", field: key, op, value },
    );
  }
  function setOp(op: Operator) {
    if (!field) return;
    const keepValue =
      !operatorIsUnary(op) &&
      !operatorIsUnary(condition.op) &&
      operatorTakesList(op) === operatorTakesList(condition.op) &&
      op !== "between" &&
      condition.op !== "between";
    const value = keepValue ? condition.value : defaultValueFor(field, op);
    onChange(
      value === undefined
        ? { type: "condition", field: condition.field, op }
        : { type: "condition", field: condition.field, op, value },
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select value={condition.field} onValueChange={setField}>
        <SelectTrigger size="sm" className="h-8 w-48 text-xs" aria-label="Field">
          <SelectValue placeholder="Field" />
        </SelectTrigger>
        <SelectContent>
          {groups.map((g) => (
            <SelectGroup key={g}>
              <SelectLabel>{g}</SelectLabel>
              {fields
                .filter((f) => f.group === g)
                .map((f) => (
                  <SelectItem key={f.key} value={f.key}>
                    {f.label}
                  </SelectItem>
                ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      <Select value={condition.op} onValueChange={(v) => setOp(v as Operator)}>
        <SelectTrigger size="sm" className="h-8 w-44 text-xs" aria-label="Operator">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ops.map((op) => (
            <SelectItem key={op} value={op}>
              {OPERATOR_LABELS[op]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {field && (
        <ValueInput
          field={field}
          op={condition.op}
          value={condition.value}
          options={options}
          onChange={(value) => onChange({ ...condition, value })}
        />
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Remove condition"
        onClick={onRemove}
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}

function ValueInput({
  field,
  op,
  value,
  options,
  onChange,
}: {
  field: ClientField;
  op: Operator;
  value: ConditionValue | undefined;
  options: OptionSources;
  onChange: (v: ConditionValue) => void;
}) {
  if (operatorIsUnary(op)) return null;

  if (operatorTakesDays(op)) {
    return (
      <span className="flex items-center gap-1 text-xs">
        <Input
          type="number"
          min={0}
          className="h-8 w-20 text-xs"
          value={String(value ?? "")}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label="Days"
        />
        days
      </span>
    );
  }
  if (op === "month_is") {
    return (
      <Select value={String(value ?? 1)} onValueChange={(v) => onChange(Number(v))}>
        <SelectTrigger size="sm" className="h-8 w-36 text-xs" aria-label="Month">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MONTHS.map((m, i) => (
            <SelectItem key={m} value={String(i + 1)}>
              {m}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (op === "between") {
    const r =
      value && typeof value === "object" && !Array.isArray(value)
        ? value
        : { from: null, to: null };
    const isDate = field.type === "date" || field.type === "datetime";
    const type = isDate ? "date" : "number";
    return (
      <span className="flex items-center gap-1 text-xs">
        <Input
          type={type}
          className="h-8 w-36 text-xs"
          value={r.from == null ? "" : String(r.from)}
          onChange={(e) => onChange({ ...r, from: e.target.value || null })}
          aria-label="From"
        />
        and
        <Input
          type={type}
          className="h-8 w-36 text-xs"
          value={r.to == null ? "" : String(r.to)}
          onChange={(e) => onChange({ ...r, to: e.target.value || null })}
          aria-label="To"
        />
      </span>
    );
  }

  const listOptions: MultiSelectOption[] | null =
    field.options?.map((o) => ({ value: o.value, label: o.label })) ??
    (field.optionsSource ? (options[field.optionsSource] ?? []) : null);

  if (operatorTakesList(op)) {
    const arr = Array.isArray(value) ? value.map(String) : [];
    if (listOptions)
      return (
        <MultiSelect
          className="w-64"
          options={listOptions}
          value={arr}
          onChange={onChange}
          placeholder="Choose…"
        />
      );
    return (
      <Input
        className="h-8 w-64 text-xs"
        placeholder="Comma-separated values"
        value={arr.join(", ")}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          )
        }
        aria-label="Values"
      />
    );
  }

  if (listOptions && (field.type === "select" || field.type === "user")) {
    return (
      <Select value={typeof value === "string" ? value : ""} onValueChange={onChange}>
        <SelectTrigger size="sm" className="h-8 w-48 text-xs" aria-label="Value">
          <SelectValue placeholder="Choose…" />
        </SelectTrigger>
        <SelectContent>
          {listOptions.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  const inputType =
    field.type === "number" || field.type === "count"
      ? "number"
      : field.type === "date" || field.type === "datetime"
        ? "date"
        : "text";
  return (
    <Input
      type={inputType}
      className="h-8 w-48 text-xs"
      value={value == null || typeof value === "object" ? "" : String(value)}
      onChange={(e) => onChange(inputType === "number" ? Number(e.target.value) : e.target.value)}
      aria-label="Value"
    />
  );
}
