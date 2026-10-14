"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { BranchScope } from "@/lib/branches/access";
import { cn } from "@/lib/utils";

import { setMemberBranches } from "./actions";

const NONE = "none";

/** Phase B: the branches one member may work in (all, or one or several) and the branch Pulse opens on. */
export function BranchAccessDialog({
  membershipId,
  displayName,
  locations,
  scope: initialScope,
  locationIds,
  homeLocationId,
  open,
  onOpenChange,
}: {
  membershipId: string;
  displayName: string;
  locations: Array<{ id: string; name: string }>;
  scope: BranchScope;
  locationIds: string[];
  homeLocationId: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [scope, setScope] = useState<BranchScope>(initialScope);
  const [chosen, setChosen] = useState<string[]>(locationIds);
  const [home, setHome] = useState<string>(homeLocationId ?? NONE);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const homeOptions = scope === "all" ? locations : locations.filter((l) => chosen.includes(l.id));

  function toggle(id: string, on: boolean) {
    setChosen((c) => (on ? [...c, id] : c.filter((x) => x !== id)));
    if (!on && home === id) setHome(NONE);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await setMemberBranches(membershipId, {
        scope,
        locationIds: scope === "all" ? [] : chosen,
        homeLocationId: home === NONE ? null : home,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast.success(res.message);
      onOpenChange(false);
    });
  }

  const option = (value: BranchScope, title: string, hint: string) => (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 text-sm",
        scope === value && "border-primary bg-primary/5",
      )}
    >
      <input
        type="radio"
        name="branch-scope"
        value={value}
        checked={scope === value}
        onChange={() => setScope(value)}
        className="accent-primary mt-1"
      />
      <span>
        <span className="font-medium">{title}</span>
        <span className="text-muted-foreground block text-xs">{hint}</span>
      </span>
    </label>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Branches for {displayName}</DialogTitle>
          <DialogDescription>
            Which branches they work in. They only see the diary, front desk, waiting list and
            enquiries of those branches.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">Branch access</legend>
            {option("all", "All branches", "Sees every branch, including new ones.")}
            {option("selected", "Only these branches", "One branch or several.")}
          </fieldset>
          {scope === "selected" && (
            <div className="flex flex-col gap-2 pl-1" role="group" aria-label="Branches">
              {locations.length === 0 && (
                <p className="text-muted-foreground text-sm">
                  No branches yet. Add them under Settings, Appointments.
                </p>
              )}
              {locations.map((l) => (
                <label key={l.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={chosen.includes(l.id)}
                    onCheckedChange={(c) => toggle(l.id, c === true)}
                  />
                  {l.name}
                </label>
              ))}
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="member-home-branch">Home branch</Label>
            <Select value={home} onValueChange={setHome}>
              <SelectTrigger id="member-home-branch">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>None (open on all their branches)</SelectItem>
                {homeOptions.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Pulse opens on this branch for them. They can switch to their other branches from the
              menu.
            </p>
          </div>
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
