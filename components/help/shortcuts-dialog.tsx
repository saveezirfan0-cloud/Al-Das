"use client";

import { useEffect } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { isHelpKey, isTypingTarget, SHORTCUT_GROUPS } from "@/lib/help/shortcuts";

export const OPEN_SHORTCUTS_EVENT = "pulse:open-shortcuts";

/** The keyboard cheat sheet. Press ? anywhere (outside a text box) to open it. */
export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!isHelpKey(e)) return;
      if (isTypingTarget(document.activeElement as HTMLElement | null)) return;
      e.preventDefault();
      onOpenChange(true);
    }
    const onEvent = () => onOpenChange(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_SHORTCUTS_EVENT, onEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_SHORTCUTS_EVENT, onEvent);
    };
  }, [onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Press ? at any time to see this list.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          {SHORTCUT_GROUPS.map((g) => (
            <section key={g.title}>
              <h3 className="text-muted-foreground mb-2 text-xs font-semibold uppercase">
                {g.title}
              </h3>
              <ul className="grid gap-1.5">
                {g.items.map((i) => (
                  <li key={i.does} className="flex items-center justify-between gap-4 text-sm">
                    <span>{i.does}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {i.keys.map((k) => (
                        <kbd
                          key={k}
                          className="bg-muted rounded border px-1.5 py-0.5 font-mono text-xs"
                        >
                          {k}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
