"use client";

import Link from "next/link";
import { Bell, Check, CheckCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";

import { useShellData } from "./shell-data";

export type { NotificationItem } from "./shell-data";

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function NotificationsMenu() {
  const { notifications: items, unread, readAll, readOne } = useShellData();

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
            <span className="bg-primary text-primary-foreground ring-background absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold tabular-nums ring-2">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold">Notifications</span>
          <Button variant="ghost" size="sm" onClick={() => void readAll()} disabled={unread === 0}>
            <Check /> Mark all read
          </Button>
        </div>
        <ScrollArea className="max-h-96">
          {items.length === 0 ? (
            <div className="text-muted-foreground flex flex-col items-center gap-2 px-3 py-8 text-center text-sm">
              <CheckCheck className="size-6 opacity-60" aria-hidden />
              <p>You&apos;re all caught up.</p>
            </div>
          ) : (
            <ul className="divide-y">
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => !n.read_at && void readOne(n.id)}
                    className="hover:bg-accent focus-visible:bg-accent focus-visible:ring-ring flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset"
                  >
                    <span className="flex w-full items-center gap-2">
                      {!n.read_at && (
                        <span className="bg-primary size-1.5 shrink-0 rounded-full" aria-hidden />
                      )}
                      <span className="truncate text-sm font-medium">
                        {!n.read_at && <span className="sr-only">Unread: </span>}
                        {n.title}
                      </span>
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
        <div className="border-t px-3 py-2 text-right">
          <Link href="/notifications" className="text-primary text-xs underline">
            Open the notification centre
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
