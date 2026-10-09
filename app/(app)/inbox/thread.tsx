"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Bot,
  Check,
  CheckCheck,
  Clock,
  MapPin,
  RotateCcw,
  Tag,
  UserPlus,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { contactDisplayName } from "@/lib/inbox/contact-name";
import { labelClass } from "@/lib/inbox/labels";
import type { MessageRow } from "@/lib/inbox/queries";
import { cn } from "@/lib/utils";
import { formatRemaining, serviceWindow } from "@/lib/whatsapp/window";

import {
  assignConversation,
  autoAssignConversation,
  retryFailedMessage,
  setBotActive,
  setConversationStatus,
  toggleConversationLabel,
  type ActionResult,
} from "./actions";
import { CloseDialog } from "./close-dialog";
import { Composer } from "./composer";
import { MediaBubble } from "./media-bubble";
import type { ConversationDetail, InboxProps } from "./types";

function Ticks({ status }: { status: string }) {
  switch (status) {
    case "queued":
    case "sending":
      return <Clock className="size-3 opacity-60" aria-label="Sending" />;
    case "sent":
      return <Check className="size-3 opacity-60" aria-label="Sent" />;
    case "delivered":
      return <CheckCheck className="size-3 opacity-60" aria-label="Delivered" />;
    case "read":
      return <CheckCheck className="size-3 text-sky-500" aria-label="Read" />;
    case "failed":
      return <AlertCircle className="text-destructive size-3" aria-label="Failed" />;
    default:
      return null;
  }
}

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "Today";
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

export function Thread(props: InboxProps & { selected: ConversationDetail; onBack: () => void }) {
  const { selected, messages, people, teams, labels, perms } = props;
  const [pending, startTransition] = useTransition();
  const [closeOpen, setCloseOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<MessageRow | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const contactName = contactDisplayName(selected.contact);
  const window_ = serviceWindow({
    lastInboundAt: selected.last_inbound_at,
    adOpenedAt: selected.ad_referral ? selected.opened_at : null,
  });

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length, selected.id]);

  function run(fn: () => Promise<ActionResult<unknown>>) {
    startTransition(async () => {
      const r = await fn();
      if (r.ok) {
        if (r.message) toast.success(r.message);
      } else toast.error(r.error);
    });
  }

  const assignee = selected.assignee_user_id
    ? people.find((p) => p.id === selected.assignee_user_id)
    : null;
  const team = selected.assignee_team_id
    ? teams.find((t) => t.id === selected.assignee_team_id)
    : null;
  const activeLabelIds = new Set(selected.conversation_labels.map((l) => l.tag_id));
  const byWaId = new Map(messages.filter((m) => m.wa_message_id).map((m) => [m.wa_message_id!, m]));

  let lastDay = "";

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          className="md:hidden"
          aria-label="Back"
          onClick={props.onBack}
        >
          <ArrowLeft />
        </Button>
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{contactName}</h2>
          <p className="text-muted-foreground truncate text-xs">
            {selected.contact.phone_e164 ?? "WhatsApp username user"} · via{" "}
            {selected.channels?.name ?? "WhatsApp"}
            {window_.open
              ? ` · window closes in ${formatRemaining(window_.remainingMs)}`
              : " · 24h window closed"}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {selected.bot_active && (
            <Badge variant="outline" className="gap-1">
              <Bot className="size-3" /> bot
            </Badge>
          )}
          {perms.send && (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={pending}>
                    <UserPlus />{" "}
                    {assignee ? assignee.name.split(" ")[0] : team ? team.name : "Assign"}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
                  <DropdownMenuItem onSelect={() => run(() => autoAssignConversation(selected.id))}>
                    Auto-assign (round-robin)
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      run(() =>
                        assignConversation({
                          conversation_id: selected.id,
                          user_id: props.me.userId,
                          team_id: selected.assignee_team_id,
                        }),
                      )
                    }
                  >
                    Assign to me
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      run(() =>
                        assignConversation({
                          conversation_id: selected.id,
                          user_id: null,
                          team_id: null,
                        }),
                      )
                    }
                  >
                    Unassign
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {teams.map((t) => (
                    <DropdownMenuItem
                      key={t.id}
                      onSelect={() =>
                        run(() =>
                          assignConversation({
                            conversation_id: selected.id,
                            user_id: null,
                            team_id: t.id,
                          }),
                        )
                      }
                    >
                      Team · {t.name}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  {[...people]
                    .sort(
                      (a, b) =>
                        (a.presence === "online" ? -1 : 1) - (b.presence === "online" ? -1 : 1),
                    )
                    .map((p) => (
                      <DropdownMenuItem
                        key={p.id}
                        onSelect={() =>
                          run(() =>
                            assignConversation({
                              conversation_id: selected.id,
                              user_id: p.id,
                              team_id: selected.assignee_team_id,
                            }),
                          )
                        }
                      >
                        <span
                          className={cn(
                            "size-2 rounded-full",
                            p.presence === "online"
                              ? "bg-emerald-500"
                              : p.presence === "away"
                                ? "bg-amber-400"
                                : "bg-gray-300",
                          )}
                        />
                        {p.name}
                      </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" aria-label="Labels">
                    <Tag />
                    {activeLabelIds.size > 0 && (
                      <span className="text-xs">{activeLabelIds.size}</span>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-56 p-2">
                  {labels.length === 0 ? (
                    <p className="text-muted-foreground p-2 text-xs">
                      No labels yet. Add them in Settings → Inbox.
                    </p>
                  ) : (
                    labels.map((l) => (
                      <label
                        key={l.id}
                        className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm"
                      >
                        <Checkbox
                          checked={activeLabelIds.has(l.id)}
                          onCheckedChange={(c) =>
                            run(() =>
                              toggleConversationLabel({
                                conversation_id: selected.id,
                                tag_id: l.id,
                                on: c === true,
                              }),
                            )
                          }
                        />
                        <span
                          className={cn("rounded px-1.5 text-xs font-medium", labelClass(l.color))}
                        >
                          {l.name}
                        </span>
                      </label>
                    ))
                  )}
                </PopoverContent>
              </Popover>
              {selected.status === "closed" ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pending}
                  onClick={() =>
                    run(() =>
                      setConversationStatus({ conversation_id: selected.id, status: "open" }),
                    )
                  }
                >
                  Reopen
                </Button>
              ) : (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" disabled={pending}>
                      Close
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setCloseOpen(true)}>
                      Close with category / summary
                    </DropdownMenuItem>
                    {selected.status !== "waiting" ? (
                      <DropdownMenuItem
                        onSelect={() =>
                          run(() =>
                            setConversationStatus({
                              conversation_id: selected.id,
                              status: "waiting",
                            }),
                          )
                        }
                      >
                        Mark as waiting for patient
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem
                        onSelect={() =>
                          run(() =>
                            setConversationStatus({ conversation_id: selected.id, status: "open" }),
                          )
                        }
                      >
                        Mark as open
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    {selected.bot_active ? (
                      <DropdownMenuItem
                        onSelect={() => run(() => setBotActive(selected.id, false))}
                      >
                        Take over from bot
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onSelect={() => run(() => setBotActive(selected.id, true))}>
                        Hand to bot
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </>
          )}
        </div>
        {selected.conversation_labels.length > 0 && (
          <div className="flex w-full flex-wrap gap-1">
            {selected.conversation_labels.map(
              (l) =>
                l.tags && (
                  <span
                    key={l.tag_id}
                    className={cn(
                      "rounded px-1.5 text-[10px] font-medium",
                      labelClass(l.tags.color),
                    )}
                  >
                    {l.tags.name}
                  </span>
                ),
            )}
          </div>
        )}
      </header>

      <div
        className="bg-muted/30 flex-1 overflow-y-auto px-4 py-3"
        role="log"
        aria-label="Messages"
      >
        {selected.ad_referral != null && (
          <p className="text-muted-foreground mb-3 text-center text-[11px]">
            Started from a click-to-WhatsApp ad
            {(selected.ad_referral as { headline?: string }).headline
              ? `: “${(selected.ad_referral as { headline?: string }).headline}”`
              : ""}
          </p>
        )}
        {messages.length === 0 && (
          <p className="text-muted-foreground py-10 text-center text-sm">No messages yet.</p>
        )}
        {messages.map((m) => {
          const day = dayLabel(m.at);
          const showDay = day !== lastDay;
          lastDay = day;
          const out = m.direction === "out";
          const note = m.direction === "note";
          const quoted = m.reply_to_wa_message_id ? byWaId.get(m.reply_to_wa_message_id) : null;
          const sender = m.profiles
            ? `${m.profiles.first_name} ${m.profiles.last_name}`.trim()
            : null;
          return (
            <div key={m.id}>
              {showDay && (
                <div className="my-3 flex justify-center">
                  <span className="bg-background text-muted-foreground rounded-full border px-2 py-0.5 text-[11px]">
                    {day}
                  </span>
                </div>
              )}
              <div className={cn("mb-1.5 flex", out || note ? "justify-end" : "justify-start")}>
                <div
                  className={cn(
                    "group relative max-w-[75%] rounded-lg px-3 py-1.5 text-sm shadow-xs",
                    note
                      ? "border border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-50"
                      : out
                        ? "bg-primary text-primary-foreground"
                        : "bg-background",
                  )}
                >
                  {note && (
                    <div className="mb-0.5 text-[10px] font-semibold tracking-wide uppercase opacity-70">
                      Internal note{sender ? ` · ${sender}` : ""}
                    </div>
                  )}
                  {out && sender && !note && (
                    <div className="mb-0.5 text-[10px] opacity-70">{sender}</div>
                  )}
                  {quoted && (
                    <div
                      className={cn(
                        "mb-1 border-l-2 pl-2 text-xs opacity-80",
                        out ? "border-primary-foreground/50" : "border-primary/50",
                      )}
                    >
                      {quoted.body ?? quoted.kind}
                    </div>
                  )}
                  {m.kind === "reaction" ? (
                    <span className="text-lg">{m.body}</span>
                  ) : m.kind === "location" ? (
                    <span className="flex items-center gap-1">
                      <MapPin className="size-3.5" /> {m.body}
                    </span>
                  ) : ["image", "video", "audio", "document", "sticker"].includes(m.kind) ? (
                    <div className="flex flex-col gap-1">
                      <MediaBubble
                        kind={m.kind}
                        path={m.media_path}
                        mime={m.media_mime}
                        filename={m.media_filename}
                        pending={
                          m.direction === "in" &&
                          !m.media_path &&
                          m.status !== "failed" &&
                          !m.error_message
                        }
                      />
                      {m.body && <p className="whitespace-pre-wrap">{m.body}</p>}
                    </div>
                  ) : m.kind === "template" ? (
                    <div>
                      <div className="mb-0.5 text-[10px] uppercase opacity-70">Template</div>
                      <p className="whitespace-pre-wrap">{m.body}</p>
                    </div>
                  ) : m.kind === "unsupported" ? (
                    <p className="text-xs italic opacity-80">
                      Unsupported message type (not shown).
                    </p>
                  ) : (
                    <p className="break-words whitespace-pre-wrap">{m.body}</p>
                  )}
                  <div
                    className={cn(
                      "mt-0.5 flex items-center justify-end gap-1 text-[10px]",
                      out ? "text-primary-foreground/70" : "text-muted-foreground",
                    )}
                  >
                    <span>
                      {new Date(m.at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    {out && <Ticks status={m.status} />}
                  </div>
                  {m.status === "failed" && (
                    <div className="mt-1 flex items-center gap-2 rounded bg-white/90 px-2 py-1 text-[11px] text-red-700 dark:bg-black/40 dark:text-red-200">
                      <span className="min-w-0 flex-1">{m.error_message ?? "Failed"}</span>
                      {perms.send && (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 underline"
                          onClick={() => run(() => retryFailedMessage(m.id))}
                        >
                          <RotateCcw className="size-3" /> retry
                        </button>
                      )}
                    </div>
                  )}
                  {!note && m.wa_message_id && perms.send && (
                    <button
                      type="button"
                      className="text-muted-foreground absolute -top-2 right-1 hidden rounded bg-white/90 px-1 text-[10px] shadow group-hover:block dark:bg-black/60"
                      onClick={() => setReplyTo(m)}
                    >
                      reply
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottom} />
      </div>

      {perms.send ? (
        <Composer
          {...props}
          selected={selected}
          windowOpen={window_.open}
          replyTo={replyTo}
          onClearReply={() => setReplyTo(null)}
        />
      ) : (
        <p className="text-muted-foreground border-t p-3 text-center text-xs">
          You can read this conversation but not reply (needs the “Send messages” permission).
        </p>
      )}
      <CloseDialog
        open={closeOpen}
        onOpenChange={setCloseOpen}
        conversationId={selected.id}
        categories={props.categories}
        settings={props.settings}
      />
    </div>
  );
}
