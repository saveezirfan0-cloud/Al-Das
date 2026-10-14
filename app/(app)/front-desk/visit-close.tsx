"use client";

import { useRef, useTransition } from "react";
import { toast } from "sonner";

import { useConfirm } from "@/components/shell/confirm-dialog";
import { Checkbox } from "@/components/ui/checkbox";

import { cancelFromDesk, markNoShow } from "./actions";

export type VisitCloseKind = "cancel" | "no_show";

/**
 * One confirmation for closing a visit from the desk, cancel or no-show, built on useConfirm() (replaces the two browser
 * confirm() pop-ups). A cancellation can also tell the patient (the mapped Cancelled template; off unless ticked) and
 * always gives the slot back to the waiting list (changeAppointmentStatus → scheduleSlotFreed()).
 */
export function useVisitClose(onDone?: () => void): {
  close: (input: { appointmentId: string; kind: VisitCloseKind; patientName?: string }) => void;
  dialog: React.ReactNode;
  pending: boolean;
} {
  const [confirm, dialog] = useConfirm();
  const [pending, startTransition] = useTransition();
  const notifyRef = useRef(false);

  function close(input: { appointmentId: string; kind: VisitCloseKind; patientName?: string }) {
    notifyRef.current = false;
    const who = input.patientName ? ` for ${input.patientName}` : "";
    void (async () => {
      const ok = await confirm(
        input.kind === "no_show"
          ? {
              title: `Mark as no-show${who}?`,
              description:
                "Use this when the patient did not come. Reminders stop and the visit counts as a no-show on the end-of-day summary.",
              confirmLabel: "Mark no-show",
              destructive: true,
            }
          : {
              title: `Cancel this appointment${who}?`,
              description: (
                <div className="flex flex-col gap-3">
                  <p>The slot goes back on offer to the waiting list. Reminders stop.</p>
                  <label className="text-foreground flex items-start gap-2 text-sm">
                    <Checkbox
                      defaultChecked={false}
                      onCheckedChange={(v) => {
                        notifyRef.current = v === true;
                      }}
                      className="mt-0.5"
                    />
                    <span>Send the patient a cancellation message on WhatsApp</span>
                  </label>
                </div>
              ),
              confirmLabel: "Cancel appointment",
              destructive: true,
            },
      );
      if (!ok) return;
      startTransition(async () => {
        const r =
          input.kind === "no_show"
            ? await markNoShow(input.appointmentId)
            : await cancelFromDesk({
                appointmentId: input.appointmentId,
                notify: notifyRef.current,
              });
        if (!r.ok) {
          toast.error(r.error);
          return;
        }
        toast.success(r.message ?? "Saved.");
        const data = "data" in r ? (r.data as { notifyError?: string } | undefined) : undefined;
        if (data?.notifyError) toast.warning(`Patient not told: ${data.notifyError}`);
        onDone?.();
      });
    })();
  }

  return { close, dialog, pending };
}
