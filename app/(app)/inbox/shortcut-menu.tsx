"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, Zap } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

import { listShortcutFlows, runShortcut, type ShortcutFlow } from "./actions";

/** Composer "Shortcut" action: pick a flow with the Shortcut trigger and run it on this conversation. */
export function ShortcutMenu({
  conversationId,
  botActive,
}: {
  conversationId: string;
  botActive: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [flows, setFlows] = useState<ShortcutFlow[] | null>(null);
  const [pending, startTransition] = useTransition();

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next && flows === null) {
      startTransition(async () => {
        const r = await listShortcutFlows();
        if (r.ok) setFlows(r.data);
        else toast.error(r.error);
      });
    }
  }

  function run(flow: ShortcutFlow) {
    startTransition(async () => {
      const r = await runShortcut({ conversation_id: conversationId, flow_id: flow.id });
      if (r.ok) {
        toast.success(r.message ?? "Started.");
        setOpen(false);
        router.refresh();
      } else toast.error(r.error);
    });
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Run a shortcut flow">
          <Zap /> Shortcut
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1">
        {pending && flows === null ? (
          <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : flows && flows.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">
            No shortcut flows yet. Create a flow with the Shortcut trigger and publish it.
          </p>
        ) : (
          <ul>
            {botActive && (
              <li className="px-2 py-1.5 text-xs text-muted-foreground">
                A bot is active here — take over before starting another flow.
              </li>
            )}
            {(flows ?? []).map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  disabled={pending || botActive}
                  onClick={() => run(f)}
                  className="w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50"
                >
                  <span className="block font-medium">{f.name}</span>
                  {f.description && (
                    <span className="block text-xs text-muted-foreground">{f.description}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
