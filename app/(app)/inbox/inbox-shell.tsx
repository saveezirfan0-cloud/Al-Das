"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useIsPhone } from "@/lib/hooks/use-media-query";
import { useVisualViewport } from "@/lib/hooks/use-visual-viewport";
import { toSearchParams } from "@/lib/inbox/folders";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

import { markConversationRead } from "./actions";
import { ConversationList } from "./conversation-list";
import { FoldersRail } from "./folders-rail";
import { Sidebar } from "./sidebar";
import { Thread } from "./thread";
import type { InboxProps } from "./types";

export function InboxShell(props: InboxProps) {
  const router = useRouter();
  // Details sit beside the thread when the inbox is wide enough (open by default) and over it when it is not
  // (closed by default), so the thread always keeps a readable width.
  const [wideDetails, setWideDetails] = useState(true);
  const [narrowDetails, setNarrowDetails] = useState(false);
  const selectedId = props.selected?.id ?? null;
  // On a phone an open conversation takes the whole screen like a native chat app, sized to the VISIBLE
  // viewport so the composer stays above the on-screen keyboard (iOS and Android).
  const phone = useIsPhone();
  const fullScreen = phone && !!selectedId;
  const viewport = useVisualViewport(fullScreen);

  // Realtime: any change to this org's conversations / the open thread / my mentions → refresh server data.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => router.refresh(), 250);
  }, [router]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`inbox:${props.orgId}:${selectedId ?? "none"}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "conversations",
          filter: `org_id=eq.${props.orgId}`,
        },
        refresh,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "mentions",
          filter: `user_id=eq.${props.me.userId}`,
        },
        refresh,
      );
    if (selectedId) {
      channel.on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${selectedId}`,
        },
        refresh,
      );
    }
    channel.subscribe();
    return () => {
      supabase.removeChannel(channel);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [props.orgId, props.me.userId, selectedId, refresh]);

  // Opening a conversation clears its unread count (and sends read receipts).
  const lastMarked = useRef<string | null>(null);
  useEffect(() => {
    if (!props.selected || !props.perms.send) return;
    const key = `${props.selected.id}:${props.selected.unread_count}`;
    if (props.selected.unread_count === 0 || lastMarked.current === key) return;
    lastMarked.current = key;
    void markConversationRead(props.selected.id);
  }, [props.selected, props.perms.send]);

  function navigate(next: Partial<typeof props.query>, conversationId: string | null = selectedId) {
    router.push(`/inbox${toSearchParams({ ...props.query, ...next }, conversationId)}`);
  }

  return (
    // Column widths follow the inbox's own width (container queries), not the window's: a docked menu panel takes
    // 16rem, and at 1280 px the old viewport breakpoints left the thread a few pixels wide.
    <div className="@container/inbox -m-4 flex h-[calc(100svh-7rem-env(safe-area-inset-bottom))] overflow-hidden md:-m-6 md:h-[calc(100svh-3.5rem)]">
      <FoldersRail
        {...props}
        onNavigate={(q) => navigate(q, null)}
        className="hidden @5xl/inbox:flex"
      />
      <ConversationList
        {...props}
        onSelect={(id) => navigate({}, id)}
        onNavigate={(q) => navigate(q, null)}
        className={cn("w-full md:w-80 @min-[90rem]/inbox:w-96", selectedId && "hidden md:flex")}
      />
      <div
        className={cn(
          "relative flex min-w-0 flex-1",
          !selectedId && "hidden md:flex",
          fullScreen && "bg-background fixed inset-x-0 z-40",
        )}
        style={
          fullScreen
            ? {
                top: viewport?.offsetTop ?? 0,
                height: viewport ? viewport.height : "100svh",
                ["--composer-safe-bottom" as string]: viewport?.keyboardOpen
                  ? "0px"
                  : "env(safe-area-inset-bottom)",
              }
            : undefined
        }
      >
        {props.selected ? (
          <>
            <Thread {...props} selected={props.selected} onBack={() => navigate({}, null)} />
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-2 right-2 z-30 hidden @7xl/inbox:inline-flex"
              aria-label={wideDetails ? "Hide details" : "Show details"}
              aria-pressed={wideDetails}
              onClick={() => setWideDetails((o) => !o)}
            >
              {wideDetails ? <PanelRightClose /> : <PanelRightOpen />}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-2 right-2 z-30 hidden md:inline-flex @7xl/inbox:hidden"
              aria-label={narrowDetails ? "Hide details" : "Show details"}
              aria-pressed={narrowDetails}
              onClick={() => setNarrowDetails((o) => !o)}
            >
              {narrowDetails ? <PanelRightClose /> : <PanelRightOpen />}
            </Button>
            {(wideDetails || narrowDetails) && (
              <Sidebar
                {...props}
                selected={props.selected}
                className={cn(
                  narrowDetails
                    ? "absolute inset-y-0 right-0 z-20 hidden shadow-xl md:flex @7xl/inbox:static @7xl/inbox:shadow-none"
                    : "hidden",
                  wideDetails ? "@7xl/inbox:flex" : "@7xl/inbox:hidden",
                )}
              />
            )}
          </>
        ) : (
          <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-1 text-sm">
            <p>Select a conversation</p>
            <p className="text-xs">
              {props.conversations.length === 0
                ? "Nothing in this folder yet."
                : `${props.conversations.length}${props.conversationsCursor ? "+" : ""} in this folder`}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
