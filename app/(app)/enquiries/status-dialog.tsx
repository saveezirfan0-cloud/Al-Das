"use client";

import { useState } from "react";

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
import {
  REASON_MAX,
  requiresReason,
  STATUS_LABELS,
  type EnquiryStatus,
} from "@/lib/enquiries/status";

/** Asks for the reason when an enquiry is marked Lost or Disqualified. */
export function StatusDialog({
  status,
  count = 1,
  pending,
  onCancel,
  onConfirm,
}: {
  status: EnquiryStatus | null;
  count?: number;
  pending?: boolean;
  onCancel: () => void;
  onConfirm: (status: EnquiryStatus, reason: string | null) => void;
}) {
  const [reason, setReason] = useState("");
  const needs = status ? requiresReason(status) : false;
  const missing = needs && !reason.trim();
  return (
    <Dialog open={status !== null} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {status
              ? `Mark ${count === 1 ? "enquiry" : `${count} enquiries`} as ${STATUS_LABELS[status].toLowerCase()}`
              : ""}
          </DialogTitle>
          <DialogDescription>
            {needs
              ? "Say why, so the team can learn from it. The reason appears on the enquiry timeline."
              : "The enquiry moves to Closed. You can reopen it at any time."}
          </DialogDescription>
        </DialogHeader>
        {needs && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="status-reason">Reason</Label>
            <Textarea
              id="status-reason"
              value={reason}
              maxLength={REASON_MAX}
              rows={3}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Chose another clinic, price, no longer needed"
            />
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button
            disabled={missing || pending}
            onClick={() => status && onConfirm(status, needs ? reason.trim() : null)}
          >
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
