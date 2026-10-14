"use client";

import { useState, useTransition } from "react";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";

import { useConfirm } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { deleteTeam } from "./actions";
import { TeamDialog, type TeamForm } from "./team-dialog";

export function TeamActions({
  team,
  people,
  teams,
}: {
  team: TeamForm & { id: string };
  people: Array<{ id: string; label: string }>;
  teams: Array<{ id: string; name: string }>;
}) {
  const [ask, askDialog] = useConfirm();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();

  async function remove() {
    if (!(await ask(`Delete the ${team.name} team?`))) return;
    startTransition(async () => {
      const res = await deleteTeam(team.id);
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for ${team.name}`}
            disabled={pending}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEditing(true)}>Edit</DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={remove}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <TeamDialog
        mode="edit"
        team={team}
        people={people}
        teams={teams}
        open={editing}
        onOpenChange={setEditing}
      />
      {askDialog}
    </>
  );
}
