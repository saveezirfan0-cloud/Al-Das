"use client";

import { useState, useTransition } from "react";
import { AlarmClock } from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fromLocalInput, toLocalInput } from "@/lib/enquiries/datetime";
import { SNOOZE_PRESETS, SNOOZE_PRESET_LABELS, isSnoozed } from "@/lib/inbox/snooze";

import { snoozeConversation, unsnoozeConversation } from "./work-actions";

/** Snooze a chat until a time: it leaves the working folders and comes back on its own (or when the patient writes). */
export function SnoozeMenu({
  conversationId,
  snoozedUntil,
  timezone,
  disabled,
}: {
  conversationId: string;
  snoozedUntil: string | null;
  timezone: string;
  disabled?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const snoozed = isSnoozed({ snoozed_until: snoozedUntil }, new Date());

  function run(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const r = await fn();
      if (r.ok) toast.success(r.message ?? "Done.");
      else toast.error(r.error);
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || pending}
            aria-label={snoozed ? "Snoozed: change or wake" : "Snooze"}
            title={
              snoozed && snoozedUntil
                ? `Snoozed until ${new Date(snoozedUntil).toLocaleString([], { timeZone: timezone })}`
                : "Snooze"
            }
          >
            <AlarmClock className={snoozed ? "text-primary" : undefined} aria-hidden />
            <span className="sr-only md:not-sr-only">{snoozed ? "Snoozed" : "Snooze"}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Snooze until</DropdownMenuLabel>
          {SNOOZE_PRESETS.map((p) => (
            <DropdownMenuItem
              key={p}
              onSelect={() => run(() => snoozeConversation({ conversation_id: conversationId, preset: p }))}
            >
              {SNOOZE_PRESET_LABELS[p]}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem
            onSelect={() => {
              setCustom(toLocalInput(new Date(Date.now() + 2 * 3600_000).toISOString(), timezone));
              setCustomOpen(true);
            }}
          >
            Choose a time…
          </DropdownMenuItem>
          {snoozed && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => run(() => unsnoozeConversation(conversationId))}>
                Wake it now
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={customOpen} onOpenChange={setCustomOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Snooze until</DialogTitle>
            <DialogDescription>
              The chat moves to Snoozed and comes back at this time, or as soon as the patient writes.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="snooze-at">Date and time</Label>
            <Input
              id="snooze-at"
              type="datetime-local"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCustomOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={pending || !custom}
              onClick={() => {
                const until = fromLocalInput(custom, timezone);
                if (!until) return void toast.error("Choose a date and time.");
                setCustomOpen(false);
                run(() => snoozeConversation({ conversation_id: conversationId, until }));
              }}
            >
              Snooze
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
