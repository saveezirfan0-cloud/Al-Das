"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/** Small building blocks for the finance forms. Every action returns { ok } | { ok: false, error }; the result is a toast. */

type Result = { ok: true; message?: string } | { ok: false; error: string };

export const selectClass =
  "border-input bg-background h-9 w-full rounded-md border px-2 text-sm focus-visible:ring-ring outline-none focus-visible:ring-[3px]";

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("flex flex-col gap-1 text-sm", className)}>
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
    </label>
  );
}

/** The browser form as a plain object of strings (what the server actions validate with zod). */
export function formValues(form: HTMLFormElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new FormData(form).entries()) if (typeof v === "string") out[k] = v;
  return out;
}

/** A form that runs a server action with its values, shows the result as a toast and calls onDone on success. */
export function ActionForm({
  action,
  children,
  submitLabel = "Save",
  className,
  onDone,
  variant = "default",
  disabled,
}: {
  action: (values: Record<string, string>) => Promise<Result>;
  children: React.ReactNode;
  submitLabel?: string;
  className?: string;
  onDone?: () => void;
  variant?: "default" | "secondary" | "outline" | "destructive";
  disabled?: boolean;
}) {
  const [pending, start] = React.useTransition();
  return (
    <form
      className={cn("flex flex-col gap-3", className)}
      onSubmit={(e) => {
        e.preventDefault();
        const values = formValues(e.currentTarget);
        start(async () => {
          const res = await action(values);
          if (res.ok) {
            toast.success(res.message ?? "Saved");
            onDone?.();
          } else toast.error(res.error);
        });
      }}
    >
      {children}
      <div>
        <Button type="submit" variant={variant} disabled={pending || disabled}>
          {pending && <Loader2 className="animate-spin" />} {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** A button that opens a right-hand drawer holding a form (house style: records open in drawers). */
export function FormSheet({
  trigger,
  title,
  description,
  children,
  variant = "default",
  size = "default",
}: {
  trigger: React.ReactNode;
  title: string;
  description?: string;
  children: (close: () => void) => React.ReactNode;
  variant?: "default" | "secondary" | "outline" | "ghost" | "link";
  size?: "default" | "sm";
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant={variant} size={size}>
          {trigger}
        </Button>
      </SheetTrigger>
      <SheetContent className="overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        <div className="px-4 pb-6">{children(() => setOpen(false))}</div>
      </SheetContent>
    </Sheet>
  );
}

/** One click, one action, a toast. `confirm` asks first (for anything that cannot be undone). */
export function RunButton({
  action,
  children,
  confirm,
  variant = "outline",
  size = "sm",
  onDone,
}: {
  action: () => Promise<Result>;
  children: React.ReactNode;
  confirm?: string;
  variant?: "default" | "secondary" | "outline" | "destructive" | "ghost";
  size?: "default" | "sm";
  onDone?: () => void;
}) {
  const [pending, start] = React.useTransition();
  return (
    <Button
      variant={variant}
      size={size}
      disabled={pending}
      onClick={() => {
        if (confirm && !window.confirm(confirm)) return;
        start(async () => {
          const res = await action();
          if (res.ok) {
            toast.success(res.message ?? "Done");
            onDone?.();
          } else toast.error(res.error);
        });
      }}
    >
      {pending && <Loader2 className="animate-spin" />} {children}
    </Button>
  );
}
