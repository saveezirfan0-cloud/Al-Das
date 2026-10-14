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
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { STATUS_LABELS, type EnquiryStatus } from "@/lib/enquiries/constants";

/**
 * Asks for the reason when an enquiry is marked Lost or Disqualified: one of the reasons set under
 * Settings → Enquiries, or free text.
 */
export function StatusReasonDialog({
  open,
  status,
  count = 1,
  reasons = [],
  pending,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  status: EnquiryStatus | null;
  count?: number;
  /** Preset reasons (Settings → Enquiries). */
  reasons?: readonly string[];
  pending?: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = React.useState("");
  React.useEffect(() => {
    if (open) setReason("");
  }, [open]);
  if (!status) return null;
  const label = STATUS_LABELS[status].toLowerCase();
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Mark {count > 1 ? `${count} enquiries` : "enquiry"} as {label}
          </DialogTitle>
          <DialogDescription>
            A reason is required. It is kept on the enquiry history.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {reasons.length > 0 && (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Common reasons">
              {reasons.map((r) => (
                <Button
                  key={r}
                  type="button"
                  size="sm"
                  variant={reason === r ? "default" : "outline"}
                  aria-pressed={reason === r}
                  onClick={() => setReason(r)}
                >
                  {r}
                </Button>
              ))}
            </div>
          )}
          <Label htmlFor="status-reason">{reasons.length ? "Or write your own" : "Reason"}</Label>
          <Textarea
            id="status-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder={
              status === "lost" ? "e.g. Chose another clinic, price" : "e.g. Not a patient enquiry"
            }
            autoFocus={reasons.length === 0}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={pending || !reason.trim()} onClick={() => onConfirm(reason.trim())}>
            {pending && <Loader2 className="animate-spin" />} Mark as {label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
