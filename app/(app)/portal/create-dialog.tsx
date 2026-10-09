"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { writableColumns } from "@/lib/portal/field-types";

import { createPortalRecord } from "./actions";
import { FieldInput } from "./field-input";
import type { PortalBootstrap } from "./types";

export function CreateDialog({
  open,
  onOpenChange,
  bootstrap,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  bootstrap: PortalBootstrap;
  onCreated: (id: string) => void;
}) {
  const def = bootstrap.object;
  const columns = writableColumns(def, "create");
  const [values, setValues] = React.useState<Record<string, unknown>>({});
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (open) {
      setValues({});
      setErrors({});
    }
  }, [open]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await createPortalRecord(def.key, values);
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
        return;
      }
      toast.success(res.message ?? "Created.");
      onOpenChange(false);
      onCreated(res.data.id);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New {def.label.toLowerCase()} record</DialogTitle>
          <DialogDescription>{def.description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid max-h-[60vh] gap-3 overflow-y-auto pr-1">
            {columns.map((c) => (
              <div key={c.key} className="grid gap-1.5">
                <Label htmlFor={`new-${c.key}`}>
                  {c.label}
                  {c.required && <span className="text-destructive"> *</span>}
                </Label>
                <FieldInput
                  id={`new-${c.key}`}
                  column={c}
                  value={values[c.key]}
                  onChange={(v) => setValues((s) => ({ ...s, [c.key]: v }))}
                  linkOptions={bootstrap.linkOptions[c.key]}
                />
                {errors[c.key] && <p className="text-destructive text-xs">{errors[c.key]}</p>}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
