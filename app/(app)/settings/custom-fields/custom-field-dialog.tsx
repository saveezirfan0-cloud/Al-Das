"use client";

import * as React from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import {
  CUSTOM_FIELD_TYPES,
  type CustomFieldDef,
  type CustomFieldType,
} from "@/lib/contacts/custom-values";

import { createCustomField, slugifyKey, updateCustomField } from "./actions";

const TYPE_LABELS: Record<CustomFieldType, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  boolean: "Yes / No",
  select: "Single select",
  multi_select: "Multi select",
  url: "URL",
  email: "Email",
  phone: "Phone",
};

type Props = (
  | { mode: "create"; field?: undefined; open?: undefined; onOpenChange?: undefined }
  | {
      mode: "edit";
      field: CustomFieldDef & { id: string };
      open: boolean;
      onOpenChange: (o: boolean) => void;
    }
) & {
  /** Which record type the field belongs to. Defaults to contact. */
  entity?: "contact" | "enquiry";
};

export function CustomFieldDialog(props: Props) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const open = props.mode === "edit" ? props.open : internalOpen;
  const setOpen = props.mode === "edit" ? props.onOpenChange : setInternalOpen;

  const [label, setLabel] = React.useState(props.field?.label ?? "");
  const [key, setKey] = React.useState(props.field?.key ?? "");
  const [keyTouched, setKeyTouched] = React.useState(props.mode === "edit");
  const [type, setType] = React.useState<CustomFieldType>(props.field?.type ?? "text");
  const [options, setOptions] = React.useState<Array<{ value: string; label: string }>>(
    props.field?.options ?? [],
  );
  const [required, setRequired] = React.useState(props.field?.required ?? false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (!open) return;
    setLabel(props.field?.label ?? "");
    setKey(props.field?.key ?? "");
    setKeyTouched(props.mode === "edit");
    setType(props.field?.type ?? "text");
    setOptions(props.field?.options ?? []);
    setRequired(props.field?.required ?? false);
    setError(null);
  }, [open, props.field, props.mode]);

  React.useEffect(() => {
    if (keyTouched || props.mode === "edit") return;
    let cancelled = false;
    slugifyKey(label).then((k) => !cancelled && setKey(k));
    return () => {
      cancelled = true;
    };
  }, [label, keyTouched, props.mode]);

  const hasOptions = type === "select" || type === "multi_select";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const cleanOptions = options
      .map((o) => ({ value: o.value.trim() || o.label.trim(), label: o.label.trim() }))
      .filter((o) => o.label);
    startTransition(async () => {
      const res =
        props.mode === "create"
          ? await createCustomField({
              entity: props.entity ?? "contact",
              key,
              label,
              type,
              options: hasOptions ? cleanOptions : [],
              required,
            })
          : await updateCustomField(props.field.id, {
              label,
              type,
              options: hasOptions ? cleanOptions : [],
              required,
            });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast.success(res.message);
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {props.mode === "create" && (
        <DialogTrigger asChild>
          <Button>
            <Plus /> New field
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {props.mode === "create" ? "New custom field" : `Edit ${props.field.label}`}
          </DialogTitle>
          <DialogDescription>
            The key is stored with each contact and used in filters and imports; it cannot change
            later.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="cf-label">Label</Label>
            <Input
              id="cf-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              required
              placeholder="e.g. Insurance plan"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="cf-key">Key</Label>
            <Input
              id="cf-key"
              value={key}
              disabled={props.mode === "edit"}
              onChange={(e) => {
                setKeyTouched(true);
                setKey(e.target.value);
              }}
              pattern="[a-z][a-z0-9_]*"
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="cf-type">Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as CustomFieldType)}>
              <SelectTrigger id="cf-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CUSTOM_FIELD_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {props.mode === "edit" && type !== props.field.type && (
              <p className="text-muted-foreground text-xs">
                Changing the type does not convert existing values; values that no longer fit read
                as empty.
              </p>
            )}
          </div>
          {hasOptions && (
            <div className="grid gap-2">
              <Label>Options</Label>
              {options.map((o, i) => (
                <div key={i} className="flex gap-2">
                  <Input
                    value={o.label}
                    onChange={(e) =>
                      setOptions(
                        options.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                      )
                    }
                    placeholder="Label"
                    aria-label={`Option ${i + 1} label`}
                  />
                  <Input
                    value={o.value}
                    onChange={(e) =>
                      setOptions(
                        options.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)),
                      )
                    }
                    placeholder="value (optional)"
                    aria-label={`Option ${i + 1} value`}
                    className="w-40"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove option"
                    onClick={() => setOptions(options.filter((_, j) => j !== i))}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => setOptions([...options, { value: "", label: "" }])}
              >
                <Plus /> Add option
              </Button>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={required} onCheckedChange={(v) => setRequired(!!v)} /> Required when
            editing a contact
          </label>
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}{" "}
              {props.mode === "create" ? "Create field" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
