"use client";

import { useState, useTransition } from "react";
import { Bookmark, Check, Trash2 } from "lucide-react";
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
import { MultiSelect } from "@/components/ui/multi-select";
import { Switch } from "@/components/ui/switch";
import type { EnquiryFilter } from "@/lib/enquiries/filter";

import { deleteEnquiryView, saveEnquiryView } from "./actions";
import type { EnquiriesBootstrap, SavedView } from "./types";

/** Saved views: pick one, save the current filters as one, share with teams or everyone. */
export function ViewsMenu({
  bootstrap,
  views,
  activeId,
  filter,
  pipelineId,
  columns,
  onApply,
  onChanged,
}: {
  bootstrap: EnquiriesBootstrap;
  views: SavedView[];
  activeId: string | null;
  filter: EnquiryFilter;
  pipelineId: string | null;
  columns: string[];
  onApply: (v: SavedView | null) => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [teams, setTeams] = useState<string[]>([]);
  const [all, setAll] = useState(false);
  const [pending, start] = useTransition();
  const active = views.find((v) => v.id === activeId);

  function save() {
    start(async () => {
      const r = await saveEnquiryView({
        name,
        pipeline_id: pipelineId,
        filter,
        columns,
        shared_team_ids: teams,
        shared_with_all: all,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("View saved.");
      setOpen(false);
      setName("");
      setTeams([]);
      setAll(false);
      onChanged();
    });
  }

  function remove(v: SavedView) {
    start(async () => {
      const r = await deleteEnquiryView(v.id);
      if (!r.ok) toast.error(r.error);
      else {
        if (activeId === v.id) onApply(null);
        onChanged();
      }
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <Bookmark /> {active ? active.name : "Views"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuItem onSelect={() => onApply(null)}>
            {!active && <Check />} All enquiries
          </DropdownMenuItem>
          {views.length > 0 && <DropdownMenuSeparator />}
          {views.length > 0 && (
            <DropdownMenuLabel className="text-xs">Saved views</DropdownMenuLabel>
          )}
          {views.map((v) => (
            <DropdownMenuItem
              key={v.id}
              onSelect={() => onApply(v)}
              className="justify-between gap-2"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {activeId === v.id && <Check />}
                <span className="truncate">{v.name}</span>
                {!v.mine && <span className="text-muted-foreground text-xs">shared</span>}
              </span>
              {v.mine && (
                <button
                  type="button"
                  aria-label={`Delete view ${v.name}`}
                  className="text-muted-foreground hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(v);
                  }}
                >
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setOpen(true)}>
            Save current filters as view…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save view</DialogTitle>
            <DialogDescription>
              Saves the pipeline, Open/Closed switch and filters you have now.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="view-name">Name</Label>
              <Input
                id="view-name"
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Share with teams</Label>
              <MultiSelect
                options={bootstrap.teams.map((t) => ({ value: t.id, label: t.name }))}
                value={teams}
                onChange={setTeams}
                placeholder="Only me"
                disabled={all}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={all} onCheckedChange={setAll} /> Share with everyone who can see
              enquiries
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!name.trim() || pending} onClick={save}>
              Save view
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
