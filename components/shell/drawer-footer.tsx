"use client";

import * as React from "react";
import { Loader2, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DISCARD_QUESTION } from "@/lib/shell/unsaved";
import { cn } from "@/lib/utils";

import { useConfirm } from "./confirm-dialog";

/**
 * The one footer for a record drawer (Phase D): sticky at the bottom of the drawer, extra actions on the left
 * (`children`, e.g. Archive), Cancel and Save on the right. Put it inside the drawer's <form>; Save submits it.
 * Pair it with `useUnsavedGuard` so Cancel, Escape and the close button ask before throwing changes away.
 */
export function DrawerFooter({
  onCancel,
  saving = false,
  saveLabel = "Save",
  cancelLabel = "Cancel",
  saveDisabled = false,
  hideSave = false,
  dirty,
  children,
  className,
}: {
  onCancel: () => void;
  saving?: boolean;
  saveLabel?: string;
  cancelLabel?: string;
  saveDisabled?: boolean;
  /** For a read-only record: Cancel only. */
  hideSave?: boolean;
  /** When given, a quiet "Unsaved changes" note shows while true. */
  dirty?: boolean;
  /** Extra actions on the left (Archive, Delete...). */
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bg-background sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t p-4",
        className,
      )}
    >
      {children}
      {dirty && (
        <span className="text-muted-foreground text-xs" role="status">
          Unsaved changes
        </span>
      )}
      <Button type="button" variant="ghost" className="ml-auto" onClick={onCancel}>
        {cancelLabel}
      </Button>
      {!hideSave && (
        <Button type="submit" disabled={saving || saveDisabled}>
          {saving ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}{" "}
          {saveLabel}
        </Button>
      )}
    </div>
  );
}

/**
 * Warns before unsaved changes are lost: `confirmClose()` asks in the app when `dirty` (resolves true when it is fine to
 * close), and the browser's own "Leave site?" prompt covers a reload or a closed tab while `dirty`. Render
 * `guardDialog` once in the drawer. Example:
 *
 *   const { confirmClose, guardDialog } = useUnsavedGuard(dirty);
 *   const close = async () => { if (await confirmClose()) onClose(); };
 *   <Sheet open={open} onOpenChange={(o) => !o && close()}>
 */
export function useUnsavedGuard(dirty: boolean): {
  confirmClose: () => Promise<boolean>;
  guardDialog: React.ReactNode;
} {
  const [ask, guardDialog] = useConfirm();
  React.useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ""; // older browsers need it set to show their prompt
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
  const confirmClose = React.useCallback(
    async () => !dirty || (await ask({ ...DISCARD_QUESTION })),
    [dirty, ask],
  );
  return { confirmClose, guardDialog };
}
