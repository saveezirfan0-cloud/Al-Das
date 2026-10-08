"use client";

import { useTransition } from "react";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { initials, PresenceDot } from "@/components/shell/user-menu";

import { changeMemberRole, removeMember, setMemberStatus } from "./actions";

export type MemberRow = {
  id: string;
  userId: string;
  name: string;
  email: string;
  designation: string | null;
  roleId: string;
  roleName: string;
  status: "active" | "suspended";
  presence: "online" | "away" | "offline";
  teams: string[];
  isSelf: boolean;
};

export function MembersTable({
  rows,
  roles,
}: {
  rows: MemberRow[];
  roles: Array<{ id: string; name: string }>;
}) {
  const [pending, startTransition] = useTransition();

  function run(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
    });
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Member</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Teams</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="w-10" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell>
              <div className="flex items-center gap-3">
                <span className="relative">
                  <Avatar>
                    <AvatarFallback>{initials(r.name, r.email)}</AvatarFallback>
                  </Avatar>
                  <PresenceDot
                    presence={r.status === "active" ? r.presence : "offline"}
                    className="absolute -right-0.5 -bottom-0.5"
                  />
                </span>
                <div className="min-w-0">
                  <div className="truncate font-medium">
                    {r.name || r.email}{" "}
                    {r.isSelf && <span className="text-muted-foreground font-normal">(you)</span>}
                  </div>
                  <div className="text-muted-foreground truncate text-xs">
                    {r.email}
                    {r.designation ? ` · ${r.designation}` : ""}
                  </div>
                </div>
              </div>
            </TableCell>
            <TableCell>{r.roleName}</TableCell>
            <TableCell className="text-muted-foreground">
              {r.teams.length ? r.teams.join(", ") : "—"}
            </TableCell>
            <TableCell>
              {r.status === "active" ? (
                <Badge variant="secondary">Active</Badge>
              ) : (
                <Badge variant="warning">Suspended</Badge>
              )}
            </TableCell>
            <TableCell>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Actions for ${r.name || r.email}`}
                    disabled={pending}
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Change role</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuLabel className="text-muted-foreground text-xs">
                        Role
                      </DropdownMenuLabel>
                      <DropdownMenuRadioGroup
                        value={r.roleId}
                        onValueChange={(roleId) => run(() => changeMemberRole(r.id, roleId))}
                      >
                        {roles.map((role) => (
                          <DropdownMenuRadioItem key={role.id} value={role.id}>
                            {role.name}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  {!r.isSelf && (
                    <>
                      <DropdownMenuSeparator />
                      {r.status === "active" ? (
                        <DropdownMenuItem
                          onSelect={() => run(() => setMemberStatus(r.id, "suspended"))}
                        >
                          Suspend access
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem
                          onSelect={() => run(() => setMemberStatus(r.id, "active"))}
                        >
                          Restore access
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => {
                          if (confirm(`Remove ${r.name || r.email} from the workspace?`))
                            run(() => removeMember(r.id));
                        }}
                      >
                        Remove from workspace
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
