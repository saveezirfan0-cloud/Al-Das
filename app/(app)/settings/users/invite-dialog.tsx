"use client";

import { useState, useTransition } from "react";
import { Copy, Loader2, UserPlus } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { inviteUser } from "./actions";

export function InviteDialog({
  roles,
  teams,
}: {
  roles: Array<{ id: string; name: string }>;
  teams: Array<{ id: string; name: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState(
    roles.find((r) => r.name === "Agent")?.id ?? roles[0]?.id ?? "",
  );
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [link, setLink] = useState<string | null>(null);
  const [linkNote, setLinkNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setEmail("");
    setTeamIds([]);
    setLink(null);
    setLinkNote(null);
    setError(null);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await inviteUser({ email, role_id: roleId, team_ids: teamIds });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast.success(res.message);
      if (res.link) {
        setLink(res.link);
        setLinkNote(res.message ?? null);
      }
      else {
        setOpen(false);
        reset();
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <UserPlus /> Invite user
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a team member</DialogTitle>
          <DialogDescription>
            They&apos;ll get a link to create their account and join this workspace.
          </DialogDescription>
        </DialogHeader>
        {link ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              {linkNote ?? "The email wasn't sent. Share this link directly."}
            </p>
            <div className="flex gap-2">
              <Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Copy link"
                onClick={() => {
                  navigator.clipboard.writeText(link);
                  toast.success("Link copied");
                }}
              >
                <Copy />
              </Button>
            </div>
            <DialogFooter>
              <Button
                type="button"
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="invite-role">Role</Label>
              <Select value={roleId} onValueChange={setRoleId}>
                <SelectTrigger id="invite-role" className="w-full">
                  <SelectValue placeholder="Pick a role" />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {teams.length > 0 && (
              <div className="grid gap-2">
                <Label>Teams</Label>
                <div className="grid gap-2 sm:grid-cols-2">
                  {teams.map((t) => (
                    <label key={t.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={teamIds.includes(t.id)}
                        onCheckedChange={(c) =>
                          setTeamIds((prev) =>
                            c ? [...prev, t.id] : prev.filter((id) => id !== t.id),
                          )
                        }
                      />
                      {t.name}
                    </label>
                  ))}
                </div>
              </div>
            )}
            {error && (
              <p className="text-destructive text-sm" role="alert">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending || !roleId}>
                {pending && <Loader2 className="animate-spin" />} Send invite
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
