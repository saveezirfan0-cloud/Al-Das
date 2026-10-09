"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pause, Play, Rocket, Trash2, XCircle, CalendarClock } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import {
  canCancel,
  canDelete,
  canPause,
  canReschedule,
  canResume,
  canStartNow,
  type CampaignStatus,
} from "@/lib/campaigns/constants";

import {
  cancelCampaignAction,
  deleteCampaignAction,
  pauseCampaignAction,
  rescheduleCampaignAction,
  resumeCampaignAction,
  startNowAction,
} from "./actions";

type Result = { ok: true; message?: string } | { ok: false; error: string };

export function DrawerControls({
  id,
  status,
  closeHref,
}: {
  id: string;
  status: CampaignStatus;
  closeHref: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [reschedule, setReschedule] = useState(false);
  const [at, setAt] = useState("");

  function run(fn: () => Promise<Result>, confirmText?: string, after?: () => void) {
    if (confirmText && !window.confirm(confirmText)) return;
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(r.message ?? "Done.");
      after?.();
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canStartNow(status) && (
        <Button
          size="sm"
          disabled={pending}
          onClick={() => run(() => startNowAction(id), "Start this campaign now?")}
        >
          <Rocket /> Start now
        </Button>
      )}
      {canReschedule(status) && (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => setReschedule(true)}>
          <CalendarClock /> Reschedule
        </Button>
      )}
      {canPause(status) && (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => run(() => pauseCampaignAction(id))}
        >
          <Pause /> Pause
        </Button>
      )}
      {canResume(status) && (
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            run(
              () => resumeCampaignAction(id),
              "Resume sending? Safety checks keep running and will pause the campaign again if the problem persists.",
            )
          }
        >
          <Play /> Resume
        </Button>
      )}
      {canCancel(status) && (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            run(
              () => cancelCampaignAction(id),
              "Cancel this campaign? Recipients who have not received it will be skipped.",
            )
          }
        >
          <XCircle /> Cancel
        </Button>
      )}
      {canDelete(status) && (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() =>
            run(
              () => deleteCampaignAction(id),
              "Delete this campaign and its recipient list? Message history stays in the inbox.",
              () => router.push(closeHref),
            )
          }
        >
          <Trash2 /> Delete
        </Button>
      )}
      {pending && <Loader2 className="text-muted-foreground size-4 animate-spin" />}

      <Dialog open={reschedule} onOpenChange={setReschedule}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Reschedule campaign</DialogTitle>
            <DialogDescription>Pick a new send time in the workspace timezone.</DialogDescription>
          </DialogHeader>
          <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setReschedule(false)}>
              Close
            </Button>
            <Button
              disabled={!at || pending}
              onClick={() =>
                run(
                  () => rescheduleCampaignAction(id, at),
                  undefined,
                  () => setReschedule(false),
                )
              }
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
