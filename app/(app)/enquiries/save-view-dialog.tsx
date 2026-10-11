"use client";

import * as React from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { EnquiryViewSummary } from "@/lib/enquiries/server";
import type { Filter } from "@/lib/filters/ast";

import { saveEnquiryView } from "./actions";
import type { EnquiriesBootstrap } from "./types";

export type ViewDraft = {
  pipelineId: string | null;
  mode: "kanban" | "table";
  filter: Filter | null;
  columns: string[];
};

/** Saves the current pipeline, layout, filters and visible columns; optionally shares them. */
export function SaveViewDialog({
  open,
  onOpenChange,
  draft,
  bootstrap,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  draft: ViewDraft;
  bootstrap: EnquiriesBootstrap;
  onSaved: (id: string) => void;
}) {
  const [name, setName] = React.useState("");
  const [sharedAll, setSharedAll] = React.useState(false);
  const [teamIds, setTeamIds] = React.useState<string[]>([]);
  const [pending, startTransition] = React.useTransition();
  const canShare = bootstrap.can.manage;

  React.useEffect(() => {
    if (open) {
      setName("");
      setSharedAll(false);
      setTeamIds([]);
    }
  }, [open]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await saveEnquiryView(null, {
        name,
        pipeline_id: draft.pipelineId,
        mode: draft.mode,
        filter: draft.filter ?? { include: { type: "group", logic: "and", children: [] } },
        columns: draft.columns,
        shared_all: sharedAll,
        shared_team_ids: sharedAll ? [] : teamIds,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message ?? "View saved.");
      onOpenChange(false);
      onSaved(res.data.id);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save this view</DialogTitle>
          <DialogDescription>
            Keeps the pipeline, Kanban or table layout, filters and visible columns.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="ev-name">Name</Label>
            <Input
              id="ev-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={60}
              placeholder="e.g. Unassigned this week"
              autoFocus
            />
          </div>
          {canShare && (
            <>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={sharedAll} onCheckedChange={(c) => setSharedAll(c === true)} />{" "}
                Share with everyone
              </label>
              {!sharedAll && bootstrap.teams.length > 0 && (
                <div className="grid gap-1">
                  <Label>Share with teams</Label>
                  {bootstrap.teams.map((t) => (
                    <label key={t.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={teamIds.includes(t.id)}
                        onCheckedChange={(c) =>
                          setTeamIds((p) => (c ? [...p, t.id] : p.filter((x) => x !== t.id)))
                        }
                      />{" "}
                      {t.name}
                    </label>
                  ))}
                </div>
              )}
            </>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending && <Loader2 className="animate-spin" />} Save view
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export type { EnquiryViewSummary };
