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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { queryToViewFilter, type InboxQuery } from "@/lib/inbox/folders";

import { saveInboxView } from "./actions";
import type { TeamInfo } from "./types";

export function SaveViewDialog({
  open,
  onOpenChange,
  query,
  teams,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  query: InboxQuery;
  teams: TeamInfo[];
}) {
  const [name, setName] = useState("");
  const [sharedAll, setSharedAll] = useState(false);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const r = await saveInboxView(null, {
        name,
        filter: queryToViewFilter(query),
        shared_all: sharedAll,
        shared_team_ids: teamIds,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(r.message);
      onOpenChange(false);
      setName("");
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save this view</DialogTitle>
          <DialogDescription>Keeps the current folder, filters, search and sort.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="view-name">Name</Label>
            <Input
              id="view-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="e.g. Unread Golden Mile"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={sharedAll} onCheckedChange={(c) => setSharedAll(c === true)} /> Share
            with everyone
          </label>
          {!sharedAll && teams.length > 0 && (
            <div className="grid gap-1">
              <Label>Share with teams</Label>
              {teams.map((t) => (
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
