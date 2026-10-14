"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pause, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { useConfirm } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";

import { deleteRecurrence, pauseRecurrence, resumeRecurrence } from "./actions";

export function RecurrenceControls({ id, active }: { id: string; active: boolean }) {
  const [ask, askDialog] = useConfirm();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  async function run(
    fn: () => Promise<{ ok: boolean; error?: string; message?: string }>,
    confirmText?: string,
  ) {
    if (confirmText && !(await ask(confirmText))) return;
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error ?? "Something went wrong.");
      else {
        toast.success(r.message ?? "Done.");
        router.refresh();
      }
    });
  }

  return (
    <span className="flex gap-1">
      {active ? (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Pause"
          title="Pause"
          disabled={pending}
          onClick={() => run(() => pauseRecurrence(id))}
        >
          <Pause />
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Play"
          title="Play"
          disabled={pending}
          onClick={() => run(() => resumeRecurrence(id))}
        >
          <Play />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Delete"
        title="Delete"
        disabled={pending}
        onClick={() =>
          run(
            () => deleteRecurrence(id),
            "Delete this recurring campaign? Campaigns it already sent are kept.",
          )
        }
      >
        <Trash2 />
      </Button>
      {askDialog}
    </span>
  );
}
