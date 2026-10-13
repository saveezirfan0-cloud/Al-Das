"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
import { budgetMeter } from "@/lib/campaigns/budget";
import { cn } from "@/lib/utils";

import { saveCampaignBudget } from "./recurring/actions";

/** This month's campaign messages against the administrator's budget, with "Set budget" for administrators. */
export function BudgetMeter({
  used,
  limit,
  canEdit,
}: {
  used: number;
  limit: number | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const meter = budgetMeter(used, limit);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(limit === null ? "" : String(limit));
  const [pending, startTransition] = useTransition();

  function save() {
    const trimmed = value.trim();
    const n = trimmed === "" ? null : Number(trimmed);
    if (n !== null && (!Number.isInteger(n) || n < 0)) {
      toast.error("Enter a whole number, or leave it empty for no limit.");
      return;
    }
    startTransition(async () => {
      const r = await saveCampaignBudget({ monthly_limit: n });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(r.message ?? "Saved.");
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 text-sm">
      <div className="min-w-48 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium">Campaign messages this month</span>
          <span className="text-muted-foreground tabular-nums">
            {meter.used.toLocaleString("en-US")}
            {meter.limit !== null ? ` of ${meter.limit.toLocaleString("en-US")}` : " (no limit)"}
          </span>
        </div>
        {meter.ratio !== null && (
          <div className="bg-muted mt-1.5 h-1.5 w-full overflow-hidden rounded-full">
            <div
              className={cn(
                "h-full",
                meter.level === "reached"
                  ? "bg-destructive"
                  : meter.level === "warn"
                    ? "bg-amber-500"
                    : "bg-primary",
              )}
              style={{ width: `${Math.round(meter.ratio * 100)}%` }}
            />
          </div>
        )}
        {meter.level === "reached" && (
          <p className="text-destructive mt-1 text-xs">
            The budget is used up: campaigns pause instead of sending until it is raised or the
            month ends.
          </p>
        )}
      </div>
      {canEdit && (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          Set budget
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Monthly campaign budget</DialogTitle>
            <DialogDescription>
              The most campaign messages that may go out in one calendar month (workspace time).
              When it is reached, campaigns pause and nothing more is sent. Test sends, chats,
              reminders and flows are not counted.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="budget-limit">Messages per month</Label>
            <Input
              id="budget-limit"
              inputMode="numeric"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="No limit"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
