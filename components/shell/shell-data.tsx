"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import {
  HEARTBEAT_INTERVAL_MS,
  heartbeatDue,
  isPresence,
  PRESENCE_EVENT,
} from "@/lib/presence/idle";
import { stripBadge, withBadge } from "@/lib/shell/title-badge";
import { createClient } from "@/lib/supabase/client";

import { markAllNotificationsRead, markNotificationRead } from "./actions";
import type { NavItem } from "./nav";

export type NotificationItem = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  read_at: string | null;
  created_at: string;
  snoozed_until?: string | null;
};

type ShellData = {
  notifications: NotificationItem[];
  unread: number;
  overdueTasks: number;
  /** Unread messages across my open conversations (drives the tab-title badge and the inbox sound). */
  inboxUnread: number;
  loaded: boolean;
  readOne(id: string): Promise<void>;
  readAll(): Promise<void>;
  refresh(): void;
};

const Ctx = createContext<ShellData | null>(null);

export function useShellData(): ShellData {
  const v = useContext(Ctx);
  if (!v)
    return {
      notifications: [],
      unread: 0,
      overdueTasks: 0,
      inboxUnread: 0,
      loaded: false,
      readOne: async () => {},
      readAll: async () => {},
      refresh: () => {},
    };
  return v;
}

/** The nav with the live overdue-task badge applied (replaces a per-request server query in the layout). */
export function useBadgedItems<T extends NavItem>(items: readonly T[]): T[] {
  const { overdueTasks } = useShellData();
  return useMemo(
    () =>
      items.map((i) =>
        i.href === "/tasks" && overdueTasks > 0 ? { ...i, badge: overdueTasks } : i,
      ),
    [items, overdueTasks],
  );
}

// --- inbox sound toggle (a per-device convenience, kept in localStorage) -----------------------------
const SOUND_KEY = "pulse:inbox-sound";
export const SOUND_EVENT = "pulse:inbox-sound-changed";

export function readSoundPref(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeSoundPref(on: boolean) {
  try {
    localStorage.setItem(SOUND_KEY, on ? "1" : "0");
  } catch {
    /* private mode: the toggle just does not persist */
  }
  window.dispatchEvent(new Event(SOUND_EVENT));
}

let audio: AudioContext | null = null;
export function playInboxChime() {
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume();
    const t = audio.currentTime;
    for (const [i, freq] of [880, 1175].entries()) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.15, t + i * 0.12 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.18);
      osc.connect(gain).connect(audio.destination);
      osc.start(t + i * 0.12);
      osc.stop(t + i * 0.12 + 0.2);
    }
  } catch {
    /* no audio (locked down browser, no gesture yet): the badge still shows */
  }
}

// --- cache so a hard reload paints with last known numbers instead of zeros -----------------------------
type Snapshot = { notifications: NotificationItem[]; overdueTasks: number; inboxUnread: number };
const cacheKey = (orgId: string, userId: string) => `pulse:shell:${orgId}:${userId}`;

function readCache(orgId: string, userId: string): Snapshot | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(orgId, userId));
    return raw ? (JSON.parse(raw) as Snapshot) : null;
  } catch {
    return null;
  }
}
function writeCache(orgId: string, userId: string, snap: Snapshot) {
  try {
    sessionStorage.setItem(cacheKey(orgId, userId), JSON.stringify(snap));
  } catch {
    /* ignore */
  }
}

const POLL_MS = 5 * 60_000; // overdue tasks and snoozes expire with the clock, not with a row change

/**
 * Notifications, the overdue-task badge and the inbox unread count, fetched in the browser with the user's own
 * session (RLS applies) and kept fresh by Realtime, instead of three queries on every page render in the
 * layout. Realtime events invalidate; a slow poll and tab focus cover time-based changes.
 */
export function ShellDataProvider({
  orgId,
  userId,
  canTasks,
  children,
}: {
  orgId: string;
  userId: string;
  canTasks: boolean;
  children: React.ReactNode;
}) {
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [overdueTasks, setOverdueTasks] = useState(0);
  const [inboxUnread, setInboxUnread] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const prevInbox = useRef<number | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const loadNotifications = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("notifications")
      .select("id, type, title, body, read_at, created_at, snoozed_until")
      .eq("org_id", orgId)
      .eq("user_id", userId)
      .or(`snoozed_until.is.null,snoozed_until.lte.${new Date().toISOString()}`)
      .order("created_at", { ascending: false })
      .limit(30);
    if (data) setNotifications(data);
  }, [orgId, userId]);

  const loadOverdue = useCallback(async () => {
    if (!canTasks) return;
    const supabase = createClient();
    const { count } = await supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("assignee_id", userId)
      .eq("done", false)
      .lt("due_at", new Date().toISOString());
    if (count !== null) setOverdueTasks(count);
  }, [canTasks, orgId, userId]);

  const loadInbox = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("conversations")
      .select("unread_count")
      .eq("org_id", orgId)
      .eq("assignee_user_id", userId)
      .neq("status", "closed")
      .gt("unread_count", 0)
      .limit(200);
    if (!data) return;
    const total = data.reduce((sum, c) => sum + c.unread_count, 0);
    if (prevInbox.current !== null && total > prevInbox.current && readSoundPref())
      playInboxChime();
    prevInbox.current = total;
    setInboxUnread(total);
  }, [orgId, userId]);

  const debounced = useCallback((key: string, fn: () => Promise<void>) => {
    const old = timers.current.get(key);
    if (old) clearTimeout(old);
    timers.current.set(
      key,
      setTimeout(() => void fn(), 300),
    );
  }, []);

  const refresh = useCallback(() => {
    void Promise.all([loadNotifications(), loadOverdue(), loadInbox()]).then(() => setLoaded(true));
  }, [loadNotifications, loadOverdue, loadInbox]);

  // First paint from the session cache, then the real numbers.
  useEffect(() => {
    const cached = readCache(orgId, userId);
    if (cached) {
      setNotifications(cached.notifications);
      setOverdueTasks(cached.overdueTasks);
      setInboxUnread(cached.inboxUnread);
      prevInbox.current = cached.inboxUnread;
    }
    refresh();
  }, [orgId, userId, refresh]);

  useEffect(() => {
    if (loaded) writeCache(orgId, userId, { notifications, overdueTasks, inboxUnread });
  }, [loaded, orgId, userId, notifications, overdueTasks, inboxUnread]);

  // Realtime invalidation.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`shell:${orgId}:${userId}`)
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
          if (n.org_id === orgId && !n.snoozed_until)
            toast(n.title, { description: n.body ?? undefined });
          debounced("n", loadNotifications);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${userId}`,
        },
        () => debounced("n", loadNotifications),
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${userId}`,
        },
        () => debounced("n", loadNotifications),
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "conversations",
          filter: `assignee_user_id=eq.${userId}`,
        },
        () => debounced("i", loadInbox),
      );
    if (canTasks) {
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tasks", filter: `assignee_id=eq.${userId}` },
        () => debounced("t", loadOverdue),
      );
    }
    channel.subscribe();
    const pending = timers.current;
    return () => {
      supabase.removeChannel(channel);
      pending.forEach((t) => clearTimeout(t));
      pending.clear();
    };
  }, [orgId, userId, canTasks, debounced, loadNotifications, loadInbox, loadOverdue]);

  // Phase 20c presence heartbeat: while the person is using Pulse (recent input, tab visible) tell the database at most
  // once a minute. With auto-away on (Settings, Inbox) an online member without heartbeats counts as away and a pg_cron
  // sweep marks them away; the next heartbeat brings them back. The rule is in lib/presence/idle.ts.
  useEffect(() => {
    const supabase = createClient();
    let lastActivity: number | null = Date.now();
    let lastSent: number | null = null;
    const onActivity = () => {
      lastActivity = Date.now();
    };
    const tick = () => {
      const now = Date.now();
      const due = heartbeatDue({
        now,
        visible: document.visibilityState === "visible",
        lastActivityAt: lastActivity,
        lastSentAt: lastSent,
      });
      if (!due) return;
      lastSent = now;
      void supabase.rpc("presence_heartbeat", { p_org_id: orgId }).then(({ data }) => {
        if (isPresence(data))
          window.dispatchEvent(new CustomEvent(PRESENCE_EVENT, { detail: data }));
      });
    };
    const inputs = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
    for (const e of inputs) window.addEventListener(e, onActivity, { passive: true });
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      onActivity();
      tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    tick();
    const timer = setInterval(tick, HEARTBEAT_INTERVAL_MS / 4);
    return () => {
      clearInterval(timer);
      for (const e of inputs) window.removeEventListener(e, onActivity);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [orgId]);

  // Time moves without row changes: poll slowly and refresh when the tab comes back.
  useEffect(() => {
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  // Tab title badge and installed-app badge.
  useEffect(() => {
    const apply = () => {
      const next = withBadge(document.title, inboxUnread);
      if (next !== document.title) document.title = next;
    };
    apply();
    const titleEl = document.querySelector("title");
    const observer = titleEl ? new MutationObserver(apply) : null;
    if (titleEl)
      observer?.observe(titleEl, { childList: true, characterData: true, subtree: true });
    const nav = navigator as Navigator & {
      setAppBadge?: (n?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (inboxUnread > 0) void nav.setAppBadge?.(inboxUnread).catch(() => {});
    else void nav.clearAppBadge?.().catch(() => {});
    return () => {
      observer?.disconnect();
      document.title = stripBadge(document.title);
    };
  }, [inboxUnread]);

  const unread = notifications.filter((n) => !n.read_at).length;

  const readOne = useCallback(async (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read_at: n.read_at ?? new Date().toISOString() } : n)),
    );
    await markNotificationRead(id);
  }, []);
  const readAll = useCallback(async () => {
    const now = new Date().toISOString();
    setNotifications((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? now })));
    await markAllNotificationsRead();
  }, []);

  const value = useMemo<ShellData>(
    () => ({ notifications, unread, overdueTasks, inboxUnread, loaded, readOne, readAll, refresh }),
    [notifications, unread, overdueTasks, inboxUnread, loaded, readOne, readAll, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
