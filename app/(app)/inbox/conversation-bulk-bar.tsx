"use client";

import { useTransition } from "react";
import { CheckCheck, Loader2, UserPlus, X } from "lucide-react";
import { toast } from "sonner";

import { useConfirm } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import type { Person, TeamInfo } from "./types";
import { bulkAssignConversations, bulkCloseConversations } from "./work-actions";

/**
 * Bulk assign / close for the conversations ticked in the list (Phase F). Each one goes through the same path as the
 * single action on the server; close-with-enquiry stays one at a time.
 */
export function ConversationBulkBar({
  ids,
  me,
  people,
  teams,
  closeNeedsDialog,
  onDone,
  onClear,
}: {
  ids: string[];
  me: string;
  people: Person[];
  teams: TeamInfo[];
  closeNeedsDialog: boolean;
  onDone: () => void;
  onClear: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [confirm, confirmDialog] = useConfirm();
  const n = ids.length;

  function run(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const r = await fn();
      if (r.ok) {
        toast.success(r.message ?? "Done.");
        onDone();
      } else toast.error(r.error);
    });
  }

  const assign = (userId: string | null, teamId: string | null) =>
    run(() => bulkAssignConversations({ ids, user_id: userId, team_id: teamId }));

  return (
    <div
      role="region"
      aria-label="Selected conversations"
      className="bg-background flex flex-wrap items-center gap-1.5 border-t px-3 py-2 text-sm"
    >
      <span className="font-medium tabular-nums">{n} selected</span>
      <Button variant="ghost" size="icon-sm" aria-label="Clear the selection" onClick={onClear}>
        <X />
      </Button>
      <span className="ml-auto" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={pending}>
            <UserPlus aria-hidden /> Assign
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
          <DropdownMenuItem onSelect={() => assign(me, null)}>Assign to me</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => assign(null, null)}>Unassign</DropdownMenuItem>
          {teams.length > 0 && <DropdownMenuSeparator />}
          {teams.map((t) => (
            <DropdownMenuItem key={t.id} onSelect={() => assign(null, t.id)}>
              Team · {t.name}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          {people.map((p) => (
            <DropdownMenuItem key={p.id} onSelect={() => assign(p.id, null)}>
              {p.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        size="sm"
        disabled={pending || closeNeedsDialog}
        title={
          closeNeedsDialog
            ? "Your workspace asks for a category or summary on close: close these one at a time."
            : undefined
        }
        onClick={async () => {
          const ok = await confirm({
            title: `Close ${n} conversation${n === 1 ? "" : "s"}?`,
            description:
              "They close without a category or summary. A patient who writes again reopens their chat.",
            confirmLabel: "Close them",
          });
          if (ok) run(() => bulkCloseConversations({ ids }));
        }}
      >
        {pending ? <Loader2 className="animate-spin" /> : <CheckCheck aria-hidden />} Close
      </Button>
      {confirmDialog}
    </div>
  );
}
