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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

import { createTeam, updateTeam, type TeamInput } from "./actions";

export type TeamForm = {
  name: string;
  description: string;
  round_robin: boolean;
  member_ids: string[];
  auto_reply_text: string;
  office_days: string[];
  office_start: string;
  office_end: string;
  fallback_team_id: string | null;
};

const EMPTY: TeamForm = {
  name: "",
  description: "",
  round_robin: false,
  member_ids: [],
  auto_reply_text: "",
  office_days: [],
  office_start: "08:00",
  office_end: "20:00",
  fallback_team_id: null,
};

const DAY_LABELS: Array<[string, string]> = [
  ["mon", "Mon"],
  ["tue", "Tue"],
  ["wed", "Wed"],
  ["thu", "Thu"],
  ["fri", "Fri"],
  ["sat", "Sat"],
  ["sun", "Sun"],
];
const NO_FALLBACK = "__none__";

type Props = {
  people: Array<{ id: string; label: string }>;
  teams: Array<{ id: string; name: string }>;
} & (
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

  const initial = props.team ?? EMPTY;
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [roundRobin, setRoundRobin] = useState(initial.round_robin);
  const [memberIds, setMemberIds] = useState<string[]>(initial.member_ids);
  const [autoReply, setAutoReply] = useState(initial.auto_reply_text);
  const [officeDays, setOfficeDays] = useState<string[]>(initial.office_days);
  const [officeStart, setOfficeStart] = useState(initial.office_start);
  const [officeEnd, setOfficeEnd] = useState(initial.office_end);
  const [fallbackId, setFallbackId] = useState<string | null>(initial.fallback_team_id);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const input = {
      name,
      description,
      round_robin: roundRobin,
      member_ids: memberIds,
      auto_reply_text: autoReply,
      office_days: officeDays as TeamInput["office_days"],
      office_start: officeStart,
      office_end: officeEnd,
      fallback_team_id: fallbackId,
    };
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
        setAutoReply("");
        setOfficeDays([]);
        setFallbackId(null);
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
      <DialogContent className="max-h-[90vh] overflow-y-auto">
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
          <fieldset className="grid gap-3 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">Routing</legend>
            <div className="grid gap-2">
              <Label htmlFor="team-fallback">Fallback team</Label>
              <Select
                value={fallbackId ?? NO_FALLBACK}
                onValueChange={(v) => setFallbackId(v === NO_FALLBACK ? null : v)}
              >
                <SelectTrigger id="team-fallback">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_FALLBACK}>None</SelectItem>
                  {props.teams
                    .filter((t) => t.id !== props.team?.id)
                    .map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                New conversations go here when nobody in this team is online, or everyone has
                reached their open conversation limit.
              </p>
            </div>
            <div className="grid gap-2">
              <Label>Office hours</Label>
              <div className="flex flex-wrap gap-2">
                {DAY_LABELS.map(([key, label]) => (
                  <label key={key} className="flex items-center gap-1 text-sm">
                    <Checkbox
                      checked={officeDays.includes(key)}
                      onCheckedChange={(c) =>
                        setOfficeDays((prev) =>
                          c ? [...prev, key] : prev.filter((d) => d !== key),
                        )
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Input
                  type="time"
                  aria-label="Opens at"
                  className="w-32"
                  value={officeStart}
                  onChange={(e) => setOfficeStart(e.target.value)}
                  disabled={officeDays.length === 0}
                />
                <span className="text-muted-foreground">to</span>
                <Input
                  type="time"
                  aria-label="Closes at"
                  className="w-32"
                  value={officeEnd}
                  onChange={(e) => setOfficeEnd(e.target.value)}
                  disabled={officeDays.length === 0}
                />
              </div>
              <p className="text-muted-foreground text-xs">
                In the workspace timezone. No days ticked means always open.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="team-auto-reply">Auto-reply message</Label>
              <Textarea
                id="team-auto-reply"
                value={autoReply}
                onChange={(e) => setAutoReply(e.target.value)}
                rows={3}
                maxLength={1024}
                placeholder="e.g. Thank you for your message. Our team will reply as soon as we are back."
              />
              <p className="text-muted-foreground text-xs">
                Sent once per conversation when a new chat lands in this team outside office hours
                or while nobody in it is online. Leave empty for no auto-reply.
              </p>
            </div>
          </fieldset>
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
