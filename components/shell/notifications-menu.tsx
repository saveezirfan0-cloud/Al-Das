"use client";

import { useEffect, useState, useTransition } from "react";
import { Bell, Check } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { createClient } from "@/lib/supabase/client";

import { markAllNotificationsRead, markNotificationRead } from "./actions";

export type NotificationItem = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  read_at: string | null;
  created_at: string;
};

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function NotificationsMenu({
  initial,
  orgId,
  userId,
}: {
  initial: NotificationItem[];
  orgId: string;
  userId: string;
}) {
  const [items, setItems] = useState(initial);
  const [pending, startTransition] = useTransition();
  const unread = items.filter((n) => !n.read_at).length;

  // Realtime: new notifications for this user appear without a refresh.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`notifications:${userId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const n = payload.new as NotificationItem & { org_id: string };
          if (n.org_id !== orgId) return;
          setItems((prev) => [n, ...prev].slice(0, 30));
          toast(n.title, { description: n.body ?? undefined });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [orgId, userId]);

  function readAll() {
    startTransition(async () => {
      await markAllNotificationsRead();
      const now = new Date().toISOString();
      setItems((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? now })));
    });
  }

  function readOne(id: string) {
    startTransition(async () => {
      await markNotificationRead(id);
      setItems((prev) =>
        prev.map((n) =>
          n.id === id ? { ...n, read_at: n.read_at ?? new Date().toISOString() } : n,
        ),
      );
    });
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
        >
          <Bell />
          {unread > 0 && (
            <span className="bg-primary text-primary-foreground absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold">Notifications</span>
          <Button variant="ghost" size="sm" onClick={readAll} disabled={pending || unread === 0}>
            <Check /> Mark all read
          </Button>
        </div>
        <ScrollArea className="max-h-96">
          {items.length === 0 ? (
            <p className="text-muted-foreground px-3 py-8 text-center text-sm">
              You&apos;re all caught up.
            </p>
          ) : (
            <ul className="divide-y">
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => !n.read_at && readOne(n.id)}
                    className="hover:bg-accent flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left"
                  >
                    <span className="flex w-full items-center gap-2">
                      {!n.read_at && (
                        <span
                          className="bg-primary size-1.5 shrink-0 rounded-full"
                          aria-label="unread"
                        />
                      )}
                      <span className="truncate text-sm font-medium">{n.title}</span>
                      <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                        {timeAgo(n.created_at)}
                      </span>
                    </span>
                    {n.body && (
                      <span className="text-muted-foreground line-clamp-2 text-xs">{n.body}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
