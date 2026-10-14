"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { COMPOSING_IDLE_MS, othersComposing, presenceChannelName } from "@/lib/inbox/presence";
import { createClient } from "@/lib/supabase/client";

type Channel = ReturnType<ReturnType<typeof createClient>["channel"]>;

/**
 * Realtime presence on the open conversation: who else is composing a reply right now (user ids only, never text).
 * `composing()` is called on every keystroke; the flag drops after a short pause, on send and when the chat closes.
 */
export function useReplyPresence(orgId: string, conversationId: string, me: string) {
  const [others, setOthers] = useState<string[]>([]);
  const channelRef = useRef<Channel | null>(null);
  const flag = useRef(false);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);

  const track = useCallback(
    (composing: boolean) => {
      flag.current = composing;
      const ch = channelRef.current;
      if (!ch) return;
      void ch.track({ user_id: me, composing, at: Date.now() }).catch(() => {});
    },
    [me],
  );

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel(presenceChannelName(orgId, conversationId), {
      config: { presence: { key: me } },
    });
    channelRef.current = channel;
    const sync = () => setOthers(othersComposing(channel.presenceState(), me, Date.now()));
    channel.on("presence", { event: "sync" }, sync);
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED")
        void channel.track({ user_id: me, composing: false, at: Date.now() });
    });
    // Stale flags (a closed laptop) fall away even when nobody else changes anything.
    const tick = setInterval(sync, 5_000);
    return () => {
      clearInterval(tick);
      if (idle.current) clearTimeout(idle.current);
      flag.current = false;
      channelRef.current = null;
      void channel.untrack().catch(() => {});
      void supabase.removeChannel(channel);
      setOthers([]);
    };
  }, [orgId, conversationId, me]);

  const composing = useCallback(() => {
    if (!flag.current) track(true);
    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(() => track(false), COMPOSING_IDLE_MS);
  }, [track]);

  const stopped = useCallback(() => {
    if (idle.current) clearTimeout(idle.current);
    if (flag.current) track(false);
  }, [track]);

  return { others, composing, stopped };
}
