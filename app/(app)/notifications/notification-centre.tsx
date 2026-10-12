"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { BellOff, Check, Clock, Eye, EyeOff, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CATEGORY_LABELS, categoryForType, type NotificationCategory } from "@/lib/notify/events";
import { notificationHref } from "@/lib/notify/links";
import { SNOOZE_LABELS, SNOOZE_PRESETS } from "@/lib/notify/snooze";
import { cn } from "@/lib/utils";

import {
  dismissNotification,
  setNotificationRead,
  snoozeNotification,
  unsnoozeNotification,
  type ActionResult,
} from "./actions";
import { markAllNotificationsRead } from "@/components/shell/actions";

export type CentreItem = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  payload: unknown;
  read_at: string | null;
  created_at: string;
  snoozed_until: string | null;
};

const STATUS_LABELS = { all: "All", unread: "Unread", snoozed: "Snoozed" } as const;

function href(
  category: NotificationCategory | null,
  status: string,
  extra: Record<string, string> = {},
) {
  const p = new URLSearchParams(extra);
  if (category) p.set("category", category);
  if (status !== "all") p.set("status", status);
  const qs = p.toString();
  return `/notifications${qs ? `?${qs}` : ""}`;
}

function when(iso: string) {
  return new Date(iso).toLocaleString([], {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function NotificationCentre({
  items,
  category,
  status,
  hasMore,
  nextLimit,
}: {
  items: CentreItem[];
  category: NotificationCategory | null;
  status: "all" | "unread" | "snoozed";
  hasMore: boolean;
  nextLimit: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function run(fn: () => Promise<ActionResult>) {
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error);
      else {
        if (r.message) toast.success(r.message);
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label="Status" className="flex rounded-md border p-0.5 text-sm">
          {(Object.keys(STATUS_LABELS) as Array<keyof typeof STATUS_LABELS>).map((s) => (
            <Link
              key={s}
              href={href(category, s)}
              aria-current={status === s ? "page" : undefined}
              className={cn(
                "flex min-h-9 items-center rounded px-3",
                status === s ? "bg-primary text-primary-foreground" : "hover:bg-accent",
              )}
            >
              {STATUS_LABELS[s]}
            </Link>
          ))}
        </nav>
        <nav aria-label="Category" className="flex flex-wrap gap-1 text-sm">
          <Link
            href={href(null, status)}
            aria-current={!category ? "page" : undefined}
            className={cn(
              "flex min-h-9 items-center rounded-full border px-3",
              !category ? "bg-accent font-medium" : "hover:bg-accent/60",
            )}
          >
            Everything
          </Link>
          {(Object.keys(CATEGORY_LABELS) as NotificationCategory[]).map((c) => (
            <Link
              key={c}
              href={href(c, status)}
              aria-current={category === c ? "page" : undefined}
              className={cn(
                "flex min-h-9 items-center rounded-full border px-3",
                category === c ? "bg-accent font-medium" : "hover:bg-accent/60",
              )}
            >
              {CATEGORY_LABELS[c]}
            </Link>
          ))}
        </nav>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={pending}
          onClick={() =>
            run(async () => {
              await markAllNotificationsRead();
              return { ok: true, message: "All marked as read." };
            })
          }
        >
          <Check /> Mark all read
        </Button>
      </div>

      {items.length === 0 ? (
        <p className="text-muted-foreground rounded-xl border p-10 text-center text-sm">
          {status === "snoozed" ? "Nothing is snoozed." : "Nothing here. You are all caught up."}
        </p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {items.map((n) => {
            const link = notificationHref(n.type, n.payload);
            const snoozed = status === "snoozed";
            return (
              <li
                key={n.id}
                className={cn("flex items-start gap-3 px-3 py-3", !n.read_at && "bg-primary/5")}
              >
                <span
                  className={cn(
                    "mt-2 size-2 shrink-0 rounded-full",
                    n.read_at ? "bg-transparent" : "bg-primary",
                  )}
                  aria-label={n.read_at ? undefined : "unread"}
                />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span className="font-medium">{n.title}</span>
                    <span className="bg-muted text-muted-foreground rounded px-1.5 text-[10px]">
                      {CATEGORY_LABELS[categoryForType(n.type)]}
                    </span>
                    <span className="text-muted-foreground text-xs">{when(n.created_at)}</span>
                  </p>
                  {n.body && <p className="text-muted-foreground line-clamp-2 text-sm">{n.body}</p>}
                  {snoozed && n.snoozed_until && (
                    <p className="text-muted-foreground mt-1 flex items-center gap-1 text-xs">
                      <Clock className="size-3" /> Comes back {when(n.snoozed_until)}
                    </p>
                  )}
                  {link && (
                    <Link
                      href={link}
                      className="text-primary mt-1 inline-block text-sm underline"
                      onClick={() => !n.read_at && void setNotificationRead(n.id, true)}
                    >
                      Open
                    </Link>
                  )}
                </div>
                <div className="flex shrink-0 items-center">
                  {snoozed ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Bring back now"
                      disabled={pending}
                      onClick={() => run(() => unsnoozeNotification(n.id))}
                    >
                      <BellOff />
                    </Button>
                  ) : (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label="Snooze" disabled={pending}>
                          <Clock />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {SNOOZE_PRESETS.map((p) => (
                          <DropdownMenuItem
                            key={p}
                            onSelect={() => run(() => snoozeNotification(n.id, p))}
                          >
                            Snooze for {SNOOZE_LABELS[p].toLowerCase()}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={n.read_at ? "Mark as unread" : "Mark as read"}
                    disabled={pending}
                    onClick={() => run(() => setNotificationRead(n.id, !n.read_at))}
                  >
                    {n.read_at ? <EyeOff /> : <Eye />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Dismiss"
                    disabled={pending}
                    onClick={() => run(() => dismissNotification(n.id))}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {hasMore && (
        <div className="text-center">
          <Button asChild variant="outline">
            <Link href={href(category, status, { limit: String(nextLimit) })}>Show older</Link>
          </Button>
        </div>
      )}
    </div>
  );
}
