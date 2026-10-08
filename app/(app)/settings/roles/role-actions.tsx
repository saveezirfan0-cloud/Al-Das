"use client";

import { useState, useTransition } from "react";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { deleteRole } from "./actions";
import { RoleDialog, type RoleInput } from "./role-dialog";

export function RoleActions({
  role,
  memberCount,
}: {
  role: RoleInput & { id: string; is_system: boolean };
  memberCount: number;
}) {
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();

  function remove() {
    if (!confirm(`Delete the ${role.name} role?`)) return;
    startTransition(async () => {
      const res = await deleteRole(role.id);
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
            aria-label={`Actions for ${role.name}`}
            disabled={pending}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEditing(true)}>Edit permissions</DropdownMenuItem>
          {!role.is_system && (
            <DropdownMenuItem variant="destructive" disabled={memberCount > 0} onSelect={remove}>
              Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <RoleDialog mode="edit" role={role} open={editing} onOpenChange={setEditing} />
    </>
  );
}
