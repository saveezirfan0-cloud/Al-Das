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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { offboardMember, previewOffboarding, type OffboardPreview } from "./actions";

/** One confirmed step: suspend, revoke API keys, hand over open work. Counts are shown before anything happens. */
export function OffboardDialog({
  membershipId,
  displayName,
  open,
  onOpenChange,
}: {
  membershipId: string;
  displayName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [preview, setPreview] = React.useState<OffboardPreview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [target, setTarget] = React.useState<string>("");
  const [typed, setTyped] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (!open) return;
    setPreview(null);
    setError(null);
    setTarget("");
    setTyped("");
    void previewOffboarding(membershipId).then((res) => {
      if (res.ok) setPreview(res.data);
      else setError(res.error);
    });
  }, [open, membershipId]);

  const handsOver = (preview?.openConversations ?? 0) + (preview?.openTasks ?? 0) > 0;

  function confirm() {
    setError(null);
    startTransition(async () => {
      const res = await offboardMember(membershipId, target || null);
      if (!res.ok) return setError(res.error);
      toast.success(res.message);
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Off-board {displayName}?</DialogTitle>
          <DialogDescription>
            This is done in one step. Their account is suspended, so they can no longer open
            anything.
          </DialogDescription>
        </DialogHeader>
        {!preview && !error && (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" /> Checking what they own…
          </div>
        )}
        {preview && (
          <div className="grid gap-4 text-sm">
            <ul className="grid gap-1 rounded-md border p-3">
              <li>
                <b>{preview.apiKeys}</b> API key{preview.apiKeys === 1 ? "" : "s"} they created will
                be revoked
              </li>
              <li>
                <b>{preview.openConversations}</b> open conversation
                {preview.openConversations === 1 ? "" : "s"} and <b>{preview.openTasks}</b> open
                task{preview.openTasks === 1 ? "" : "s"} will be handed over
              </li>
              <li>
                They will be removed from <b>{preview.teams}</b> team
                {preview.teams === 1 ? "" : "s"}
              </li>
              <li>Their signed-in devices are marked as revoked</li>
            </ul>
            {handsOver && (
              <div className="grid gap-1.5">
                <Label htmlFor="offboard-target">Hand their open work to</Label>
                <select
                  id="offboard-target"
                  className="border-input bg-background h-9 rounded-md border px-2 text-sm"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  <option value="">Nobody (leave unassigned)</option>
                  {preview.candidates.map((c) => (
                    <option key={c.userId} value={c.userId}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="offboard-confirm">
                Type <b>off-board</b> to confirm
              </Label>
              <Input
                id="offboard-confirm"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
              />
            </div>
          </div>
        )}
        {error && <p className="text-destructive text-sm">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={confirm}
            disabled={pending || !preview || typed.trim().toLowerCase() !== "off-board"}
          >
            {pending && <Loader2 className="animate-spin" />} Off-board
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
