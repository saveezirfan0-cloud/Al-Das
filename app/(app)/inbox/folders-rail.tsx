"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { AlertTriangle, Bookmark, Plus, Trash2, Users } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FOLDERS, type InboxQuery } from "@/lib/inbox/folders";
import { cn } from "@/lib/utils";

import { deleteInboxView } from "./actions";
import { NewConversationDialog } from "./new-conversation-dialog";
import type { InboxProps } from "./types";

export function FoldersRail({
  query,
  counts,
  teams,
  views,
  channels,
  me,
  perms,
  className,
  onNavigate,
}: InboxProps & { className?: string; onNavigate: (q: Partial<InboxQuery>) => void }) {
  const [pending, startTransition] = useTransition();
  const [newOpen, setNewOpen] = useState(false);
  const base: Partial<InboxQuery> = {
    team: null,
    view: null,
    q: "",
    status: "any",
    label: null,
    channel: null,
    assignee: null,
  };

  function Item({
    active,
    label,
    count,
    onClick,
    icon,
    trailing,
  }: {
    active: boolean;
    label: string;
    count?: number;
    onClick: () => void;
    icon?: React.ReactNode;
    trailing?: React.ReactNode;
  }) {
    return (
      <div
        className={cn(
          "group flex items-center rounded-md text-sm",
          active ? "bg-sidebar-accent font-medium" : "hover:bg-sidebar-accent/60",
        )}
      >
        <button
          type="button"
          onClick={onClick}
          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
          aria-current={active ? "page" : undefined}
        >
          {icon}
          <span className="truncate">{label}</span>
          {count !== undefined && count > 0 && (
            <span className="text-muted-foreground ml-auto text-xs tabular-nums">{count}</span>
          )}
        </button>
        {trailing}
      </div>
    );
  }

  return (
    <aside
      className={cn(
        "bg-sidebar text-sidebar-foreground border-sidebar-border w-56 shrink-0 flex-col border-r",
        className,
      )}
    >
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-semibold tracking-wide uppercase opacity-70">Inbox</span>
        {perms.send && channels.some((c) => c.status === "active") && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="New conversation"
            onClick={() => setNewOpen(true)}
          >
            <Plus />
          </Button>
        )}
      </div>
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-0.5 px-2 pb-3">
          {FOLDERS.map((f) => (
            <Item
              key={f.key}
              active={!query.team && !query.view && query.folder === f.key}
              label={f.label}
              count={counts.folders[f.key]}
              onClick={() => onNavigate({ ...base, folder: f.key })}
            />
          ))}

          {teams.length > 0 && (
            <>
              <div className="text-muted-foreground mt-3 px-2 text-[11px] font-semibold tracking-wide uppercase">
                Teams
              </div>
              {teams.map((t) => (
                <Item
                  key={t.id}
                  active={query.team === t.id}
                  label={t.name}
                  count={counts.teams[t.id]}
                  icon={<Users className="size-3.5 opacity-60" />}
                  onClick={() => onNavigate({ ...base, folder: "open", team: t.id })}
                />
              ))}
            </>
          )}

          {views.length > 0 && (
            <>
              <div className="text-muted-foreground mt-3 px-2 text-[11px] font-semibold tracking-wide uppercase">
                Saved views
              </div>
              {views.map((v) => (
                <Item
                  key={v.id}
                  active={query.view === v.id}
                  label={v.name}
                  icon={<Bookmark className="size-3.5 opacity-60" />}
                  onClick={() => onNavigate({ ...base, view: v.id })}
                  trailing={
                    v.owner_id === me.userId ? (
                      <button
                        type="button"
                        aria-label={`Delete view ${v.name}`}
                        disabled={pending}
                        className="text-muted-foreground hover:text-destructive hidden px-1.5 group-hover:block"
                        onClick={() =>
                          startTransition(async () => {
                            const r = await deleteInboxView(v.id);
                            if (r.ok) toast.success(r.message);
                            else toast.error(r.error);
                          })
                        }
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    ) : undefined
                  }
                />
              ))}
            </>
          )}

          <div className="mt-3 border-t pt-2">
            <Link
              href="/inbox/failed"
              className="hover:bg-sidebar-accent/60 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm"
            >
              <AlertTriangle className="size-3.5 text-amber-600" /> Failed messages
            </Link>
          </div>
        </div>
      </ScrollArea>
      <NewConversationDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        channels={channels}
        canCreateContacts={perms.contactsManage}
      />
    </aside>
  );
}
