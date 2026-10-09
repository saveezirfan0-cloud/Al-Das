"use client";

import { useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

type Result = { ok: true; message?: string } | { ok: false; error: string };

/** A form that runs a server action, reports the result as a toast, and keeps its values. */
export function RowForm({
  action,
  children,
  label = "Save",
  className,
}: {
  action: (formData: FormData) => Promise<Result>;
  children: React.ReactNode;
  label?: string;
  className?: string;
}) {
  const [pending, start] = useTransition();
  return (
    <form
      className={className ?? "flex flex-wrap items-center gap-2"}
      action={(fd) =>
        start(async () => {
          const res = await action(fd);
          if (res.ok) toast.success(res.message ?? "Saved");
          else toast.error(res.error);
        })
      }
    >
      {children}
      <Button type="submit" size="sm" variant="secondary" disabled={pending}>
        {pending && <Loader2 className="animate-spin" />} {label}
      </Button>
    </form>
  );
}

export function ActionButton({
  action,
  children,
}: {
  action: () => Promise<Result>;
  children: React.ReactNode;
}) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await action();
          if (res.ok) toast.success(res.message ?? "Done");
          else toast.error(res.error);
        })
      }
    >
      {pending && <Loader2 className="animate-spin" />} {children}
    </Button>
  );
}
