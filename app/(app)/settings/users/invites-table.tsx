"use client";

import { useTransition } from "react";
import { Copy, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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

import { resendInvite, revokeInvite } from "./actions";

type Row = {
  id: string;
  email: string;
  roleName: string;
  createdAt: string;
  expiresAt: string;
  state: "valid" | "expired" | "accepted" | "revoked";
};

export function InvitesTable({ rows }: { rows: Row[] }) {
  const [pending, startTransition] = useTransition();

  function run(
    fn: () => Promise<{ ok: boolean; message?: string; error?: string; link?: string }>,
  ) {
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) toast.error(res.error);
      else if (res.link) {
        toast.success(res.message, {
          action: { label: "Copy link", onClick: () => navigator.clipboard.writeText(res.link!) },
          icon: <Copy className="size-4" />,
          duration: 15000,
        });
      } else toast.success(res.message);
    });
  }

  if (rows.length === 0)
    return <p className="text-muted-foreground text-sm">No pending invites.</p>;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Email</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Expires</TableHead>
          <TableHead className="w-10" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell>{r.email}</TableCell>
            <TableCell>{r.roleName}</TableCell>
            <TableCell>
              <Badge variant={r.state === "valid" ? "secondary" : "warning"}>
                {r.state === "valid" ? "Pending" : "Expired"}
              </Badge>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {new Date(r.expiresAt).toLocaleDateString()}
            </TableCell>
            <TableCell>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Invite actions"
                    disabled={pending}
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => run(() => resendInvite(r.id))}>
                    Resend (new link)
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => run(() => revokeInvite(r.id))}
                  >
                    Revoke
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
