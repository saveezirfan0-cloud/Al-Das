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
import { Switch } from "@/components/ui/switch";
import type { Filter } from "@/lib/filters/ast";
import type { SavedViewDto } from "@/lib/portal/server";

import { savePortalView } from "./actions";
import type { PortalGridPrefs } from "./types";

export function SaveViewDialog({
  open,
  onOpenChange,
  objectKey,
  existing,
  canShare,
  snapshot,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  objectKey: string;
  /** Updating one of the member's own views (name prefilled) instead of creating a new one. */
  existing?: SavedViewDto | null;
  canShare: boolean;
  snapshot: {
    filter: Filter | null;
    columns: PortalGridPrefs["columns"];
    sort: Array<{ field: string; dir: "asc" | "desc" }>;
  };
  onSaved: (id: string) => void;
}) {
  const [name, setName] = React.useState("");
  const [shared, setShared] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (open) {
      setName(existing?.name ?? "");
      setShared(existing?.sharedAll ?? false);
    }
  }, [open, existing]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await savePortalView(objectKey, {
        id: existing?.id,
        name,
        filter: snapshot.filter,
        columns: snapshot.columns,
        sort: snapshot.sort,
        sharedAll: shared,
        sharedTeamIds: existing?.sharedTeamIds ?? [],
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message ?? "Saved.");
      onOpenChange(false);
      onSaved(res.data.id);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{existing ? "Update view" : "Save view"}</DialogTitle>
          <DialogDescription>
            Saves the current filters, sort order and visible columns.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="view-name">Name</Label>
            <Input
              id="view-name"
              value={name}
              maxLength={80}
              required
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {canShare && (
            <label className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <span>
                <span className="font-medium">Share with everyone</span>
                <span className="text-muted-foreground block text-xs">
                  Colleagues who can read this object see the view.
                </span>
              </span>
              <Switch checked={shared} onCheckedChange={setShared} />
            </label>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending && <Loader2 className="animate-spin" />} Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
