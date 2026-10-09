"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
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
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const selectedId = props.selected?.id ?? null;

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
    <div className="-m-4 flex h-[calc(100svh-3.5rem)] overflow-hidden md:-m-6">
      <FoldersRail {...props} onNavigate={(q) => navigate(q, null)} className="hidden lg:flex" />
      <ConversationList
        {...props}
        onSelect={(id) => navigate({}, id)}
        onNavigate={(q) => navigate(q, null)}
        className={cn("w-full md:w-80 lg:w-96", selectedId && "hidden md:flex")}
      />
      <div className={cn("relative flex min-w-0 flex-1", !selectedId && "hidden md:flex")}>
        {props.selected ? (
          <>
            <Thread {...props} selected={props.selected} onBack={() => navigate({}, null)} />
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-2 right-2 z-10 hidden xl:inline-flex"
              aria-label={sidebarOpen ? "Hide details" : "Show details"}
              onClick={() => setSidebarOpen((o) => !o)}
            >
              {sidebarOpen ? <PanelRightClose /> : <PanelRightOpen />}
            </Button>
            {sidebarOpen && (
              <Sidebar {...props} selected={props.selected} className="hidden xl:flex" />
            )}
          </>
        ) : (
          <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-1 text-sm">
            <p>Select a conversation</p>
            <p className="text-xs">
              {props.conversations.length === 0
                ? "Nothing in this folder yet."
                : `${props.conversations.length} in this folder`}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
