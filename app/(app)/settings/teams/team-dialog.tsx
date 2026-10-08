"use client";

import { useState, useTransition } from "react";
import { Loader2, Plus } from "lucide-react";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

import { createTeam, updateTeam } from "./actions";

export type TeamForm = {
  name: string;
  description: string;
  round_robin: boolean;
  member_ids: string[];
};

type Props = { people: Array<{ id: string; label: string }> } & (
  | { mode: "create"; team?: undefined; open?: undefined; onOpenChange?: undefined }
  | {
      mode: "edit";
      team: TeamForm & { id: string };
      open: boolean;
      onOpenChange: (o: boolean) => void;
    }
);

export function TeamDialog(props: Props) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = props.mode === "edit" ? props.open : internalOpen;
  const setOpen = props.mode === "edit" ? props.onOpenChange : setInternalOpen;

  const initial = props.team ?? { name: "", description: "", round_robin: false, member_ids: [] };
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [roundRobin, setRoundRobin] = useState(initial.round_robin);
  const [memberIds, setMemberIds] = useState<string[]>(initial.member_ids);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const input = { name, description, round_robin: roundRobin, member_ids: memberIds };
    startTransition(async () => {
      const res =
        props.mode === "create" ? await createTeam(input) : await updateTeam(props.team.id, input);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast.success(res.message);
      setOpen(false);
      if (props.mode === "create") {
        setName("");
        setDescription("");
        setRoundRobin(false);
        setMemberIds([]);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {props.mode === "create" && (
        <DialogTrigger asChild>
          <Button>
            <Plus /> New team
          </Button>
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {props.mode === "create" ? "New team" : `Edit ${props.team.name}`}
          </DialogTitle>
          <DialogDescription>
            Teams receive conversations and enquiries as a group.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="team-name">Name</Label>
            <Input
              id="team-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="e.g. Front desk"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="team-desc">Description</Label>
            <Textarea
              id="team-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>
          <label className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
            <span>
              <span className="font-medium">Round-robin assignment</span>
              <span className="text-muted-foreground block text-xs">
                Share new conversations evenly across online members.
              </span>
            </span>
            <Switch checked={roundRobin} onCheckedChange={setRoundRobin} />
          </label>
          <div className="grid gap-2">
            <Label>Members</Label>
            {props.people.length === 0 ? (
              <p className="text-muted-foreground text-sm">Invite users first.</p>
            ) : (
              <ScrollArea className="h-48 rounded-md border">
                <div className="flex flex-col gap-2 p-3">
                  {props.people.map((p) => (
                    <label key={p.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={memberIds.includes(p.id)}
                        onCheckedChange={(c) =>
                          setMemberIds((prev) =>
                            c ? [...prev, p.id] : prev.filter((id) => id !== p.id),
                          )
                        }
                      />
                      {p.label}
                    </label>
                  ))}
                </div>
              </ScrollArea>
            )}
          </div>
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}{" "}
              {props.mode === "create" ? "Create team" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
