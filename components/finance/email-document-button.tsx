"use client";

import * as React from "react";
import { Loader2, Mail } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type Result = { ok: true; message?: string } | { ok: false; error: string };

/**
 * "E-mail …" with a confirmation that names who will receive the document (Phase G). The action is a bound server action:
 * it re-checks the permission and that the address is still the one shown here, then queues the e-mail.
 */
export function EmailDocumentButton({
  label,
  title,
  description,
  recipients,
  action,
  disabledReason,
}: {
  label: string;
  title: string;
  description: string;
  recipients: ReadonlyArray<{ name: string; email: string }>;
  action: () => Promise<Result>;
  /** When set, the button is disabled and this says why (e.g. no address on file). */
  disabledReason?: string | null;
}) {
  const [open, setOpen] = React.useState(false);
  const [pending, start] = React.useTransition();
  if (disabledReason)
    return (
      <Button variant="outline" size="sm" disabled title={disabledReason} className="print:hidden">
        <Mail aria-hidden /> {label}
      </Button>
    );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="print:hidden">
          <Mail aria-hidden /> {label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">
            {recipients.length === 1 ? "Recipient" : "Recipients"}
          </span>
          <ul className="flex flex-col gap-1">
            {recipients.map((r) => (
              <li key={r.email} className="bg-muted rounded-md px-3 py-2">
                <span className="font-medium">{r.name}</span>{" "}
                <span className="text-muted-foreground break-all">&lt;{r.email}&gt;</span>
              </li>
            ))}
          </ul>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await action();
                if (res.ok) {
                  toast.success(res.message ?? "Sent");
                  setOpen(false);
                } else toast.error(res.error);
              })
            }
          >
            {pending && <Loader2 className="animate-spin" aria-hidden />} Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
