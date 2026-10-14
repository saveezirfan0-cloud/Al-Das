"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * A confirmation step for destructive or sensitive actions. `typeToConfirm` asks the person to type a
 * word first (use it for actions that cannot be undone). The dialog stays open while the action runs
 * and closes on success; a failure leaves it open with the message.
 */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  destructive = false,
  typeToConfirm,
  children,
  onConfirm,
}: {
  trigger: React.ReactNode;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  typeToConfirm?: string;
  children?: React.ReactNode;
  onConfirm: () => Promise<{ ok: boolean; error?: string } | void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [typed, setTyped] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const ready = !typeToConfirm || typed.trim().toLowerCase() === typeToConfirm.toLowerCase();

  function run() {
    setError(null);
    startTransition(async () => {
      const res = await onConfirm();
      if (res && !res.ok) return setError(res.error ?? "Something went wrong.");
      setOpen(false);
      setTyped("");
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setError(null);
          setTyped("");
        }
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div>{description}</div>
          </DialogDescription>
        </DialogHeader>
        {children}
        {typeToConfirm && (
          <div className="grid gap-2">
            <Label htmlFor="confirm-word">
              Type <b>{typeToConfirm}</b> to continue
            </Label>
            <Input
              id="confirm-word"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
            />
          </div>
        )}
        {error && <p className="text-destructive text-sm">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            onClick={run}
            disabled={pending || !ready}
          >
            {pending && <Loader2 className="animate-spin" />} {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type ConfirmOptions = {
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
};

/**
 * The in-app replacement for the browser's `confirm()`: `const [confirm, confirmDialog] = useConfirm();` then
 * `if (!(await confirm({ title: "Mark as no-show?" }))) return;` and render `{confirmDialog}` once in the component.
 * Cancel, Escape and clicking outside all answer false.
 */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, React.ReactNode] {
  const [request, setRequest] = React.useState<
    (ConfirmOptions & { resolve: (ok: boolean) => void }) | null
  >(null);

  const confirm = React.useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setRequest({ ...options, resolve });
      }),
    [],
  );

  function answer(ok: boolean) {
    request?.resolve(ok);
    setRequest(null);
  }

  const dialog = (
    <Dialog open={request !== null} onOpenChange={(o) => !o && answer(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{request?.title}</DialogTitle>
          {request?.description ? (
            <DialogDescription asChild>
              <div>{request.description}</div>
            </DialogDescription>
          ) : (
            <DialogDescription className="sr-only">Confirm or cancel.</DialogDescription>
          )}
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => answer(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={request?.destructive ? "destructive" : "default"}
            onClick={() => answer(true)}
            autoFocus
          >
            {request?.confirmLabel ?? "Continue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return [confirm, dialog];
}
