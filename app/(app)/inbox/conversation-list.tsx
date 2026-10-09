"use client";

import { useEffect, useState } from "react";
import { ArrowDownUp, Bookmark, Bot, Filter, Search, X } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { contactDisplayName } from "@/lib/inbox/contact-name";
import { FOLDERS, type InboxQuery } from "@/lib/inbox/folders";
import { labelClass } from "@/lib/inbox/labels";
import { cn } from "@/lib/utils";

import { SaveViewDialog } from "./save-view-dialog";
import type { InboxProps } from "./types";

const ANY = "__any__";

export function timeLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "2-digit", month: "short" });
}

export function initials(name: string): string {
  const parts = name
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim()
    .split(/\s+/);
  const s = (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "");
  return s.toUpperCase() || "?";
}

export function ConversationList({
  query,
  conversations,
  selected,
  channels,
  labels,
  people,
  teams,
  perms,
  className,
  onSelect,
  onNavigate,
}: InboxProps & {
  className?: string;
  onSelect: (id: string) => void;
  onNavigate: (q: Partial<InboxQuery>) => void;
}) {
  const [search, setSearch] = useState(query.q);
  const [saveOpen, setSaveOpen] = useState(false);
  useEffect(() => setSearch(query.q), [query.q]);

  const title = query.team
    ? (teams.find((t) => t.id === query.team)?.name ?? "Team")
    : query.view
      ? "Saved view"
      : (FOLDERS.find((f) => f.key === query.folder)?.label ?? "Inbox");
  const filtersOn = query.status !== "any" || !!query.label || !!query.channel || !!query.assignee;
  const peopleById = new Map(people.map((p) => [p.id, p]));

  return (
    <section
      className={cn("bg-background flex shrink-0 flex-col border-r", className)}
      aria-label="Conversations"
    >
      <div className="flex items-center gap-1 border-b px-3 py-2">
        <h2 className="truncate text-sm font-semibold">{title}</h2>
        <span className="text-muted-foreground text-xs">{conversations.length}</span>
        <div className="ml-auto flex items-center">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={query.sort === "newest" ? "Sort: newest first" : "Sort: oldest first"}
            onClick={() => onNavigate({ sort: query.sort === "newest" ? "oldest" : "newest" })}
          >
            <ArrowDownUp className={cn(query.sort === "oldest" && "rotate-180")} />
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Filters"
                className={cn(filtersOn && "text-primary")}
              >
                <Filter />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="flex w-64 flex-col gap-3">
              <label className="grid gap-1 text-xs">
                Status
                <Select
                  value={query.status}
                  onValueChange={(v) => onNavigate({ status: v as InboxQuery["status"] })}
                >
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Any</SelectItem>
                    <SelectItem value="open">Open</SelectItem>
                    <SelectItem value="waiting">Waiting</SelectItem>
                    <SelectItem value="closed">Closed</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="grid gap-1 text-xs">
                Number
                <Select
                  value={query.channel ?? ANY}
                  onValueChange={(v) => onNavigate({ channel: v === ANY ? null : v })}
                >
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>All numbers</SelectItem>
                    {channels.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="grid gap-1 text-xs">
                Label
                <Select
                  value={query.label ?? ANY}
                  onValueChange={(v) => onNavigate({ label: v === ANY ? null : v })}
                >
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>Any label</SelectItem>
                    {labels.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              {perms.viewAll && (
                <label className="grid gap-1 text-xs">
                  Assignee
                  <Select
                    value={query.assignee ?? ANY}
                    onValueChange={(v) => onNavigate({ assignee: v === ANY ? null : v })}
                  >
                    <SelectTrigger size="sm" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANY}>Anyone</SelectItem>
                      {people.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              )}
              <div className="flex justify-between">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    onNavigate({ status: "any", label: null, channel: null, assignee: null })
                  }
                >
                  Clear
                </Button>
                <Button variant="outline" size="sm" onClick={() => setSaveOpen(true)}>
                  <Bookmark /> Save view
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      <form
        className="relative border-b px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          onNavigate({ q: search.trim() });
        }}
      >
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-5 size-4 -translate-y-1/2" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or phone"
          className="h-8 pl-8 text-sm"
          aria-label="Search conversations"
        />
        {query.q && (
          <button
            type="button"
            aria-label="Clear search"
            className="text-muted-foreground absolute top-1/2 right-5 -translate-y-1/2"
            onClick={() => onNavigate({ q: "" })}
          >
            <X className="size-4" />
          </button>
        )}
      </form>
      <ScrollArea className="flex-1">
        {conversations.length === 0 ? (
          <p className="text-muted-foreground p-6 text-center text-sm">No conversations here.</p>
        ) : (
          <ul className="divide-y">
            {conversations.map((c) => {
              const name = c.contacts ? contactDisplayName(c.contacts) : "Unknown";
              const active = selected?.id === c.id;
              const assignee = c.assignee_user_id ? peopleById.get(c.assignee_user_id) : null;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(c.id)}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "hover:bg-accent/60 flex w-full items-start gap-3 px-3 py-2.5 text-left",
                      active && "bg-accent",
                    )}
                  >
                    <div className="relative shrink-0">
                      <Avatar className="size-9">
                        <AvatarFallback>{initials(name)}</AvatarFallback>
                      </Avatar>
                      <span
                        className="bg-background absolute -right-1 -bottom-1 rounded-full p-px"
                        title={c.channels?.name ?? "WhatsApp"}
                      >
                        <span className="flex size-4 items-center justify-center rounded-full bg-emerald-500 text-[9px] font-bold text-white">
                          W
                        </span>
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span
                          className={cn(
                            "truncate text-sm",
                            c.unread_count > 0 ? "font-semibold" : "font-medium",
                          )}
                        >
                          {name}
                        </span>
                        <span className="text-muted-foreground ml-auto shrink-0 text-[11px]">
                          {timeLabel(c.last_message_at)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <p
                          className={cn(
                            "text-muted-foreground min-w-0 flex-1 truncate text-xs",
                            c.unread_count > 0 && "text-foreground",
                          )}
                        >
                          {c.last_message_direction === "out" && (
                            <span className="opacity-60">You: </span>
                          )}
                          {c.last_message_preview ?? "No messages yet"}
                        </p>
                        {c.bot_active && (
                          <Bot
                            className="text-muted-foreground size-3.5 shrink-0"
                            aria-label="Bot active"
                          />
                        )}
                        {c.unread_count > 0 && (
                          <span className="bg-primary text-primary-foreground shrink-0 rounded-full px-1.5 text-[10px] font-semibold">
                            {c.unread_count}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {c.status === "waiting" && (
                          <span className="rounded bg-amber-100 px-1 text-[10px] text-amber-800">
                            waiting
                          </span>
                        )}
                        {c.status === "closed" && (
                          <span className="bg-muted rounded px-1 text-[10px]">closed</span>
                        )}
                        {c.conversation_labels.map(
                          (l) =>
                            l.tags && (
                              <span
                                key={l.tag_id}
                                className={cn(
                                  "rounded px-1 text-[10px] font-medium",
                                  labelClass(l.tags.color),
                                )}
                              >
                                {l.tags.name}
                              </span>
                            ),
                        )}
                        {assignee && (
                          <span className="text-muted-foreground ml-auto text-[10px]">
                            {assignee.name.split(" ")[0]}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </ScrollArea>
      <SaveViewDialog open={saveOpen} onOpenChange={setSaveOpen} query={query} teams={teams} />
    </section>
  );
}
