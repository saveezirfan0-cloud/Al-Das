/**
 * "Someone else is replying" (Phase F). Each open conversation joins a Realtime presence channel and tracks one tiny
 * state: whether the person is composing, and when that was last said. No message text, no names: the screen maps
 * the user ids to colleagues it already lists. Pure helpers here; the hook is app/(app)/inbox/use-reply-presence.ts.
 */

export type ReplyPresence = { user_id: string; composing: boolean; at: number };

/** A composing flag older than this is ignored (a closed tab may not say it stopped). */
export const COMPOSING_STALE_MS = 20_000;
/** Typing pauses longer than this count as stopped. */
export const COMPOSING_IDLE_MS = 6_000;

export function presenceChannelName(orgId: string, conversationId: string): string {
  return `reply:${orgId}:${conversationId}`;
}

function asPresence(v: unknown): ReplyPresence | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.user_id !== "string" || typeof o.composing !== "boolean" || typeof o.at !== "number")
    return null;
  return { user_id: o.user_id, composing: o.composing, at: o.at };
}

/**
 * The other people (user ids, sorted) composing a reply now, from a presence state (key → list of metas; one person
 * may have several tabs open). Malformed entries and stale flags are ignored.
 */
export function othersComposing(
  state: Record<string, readonly unknown[]>,
  me: string,
  now: number,
): string[] {
  const out = new Set<string>();
  for (const metas of Object.values(state)) {
    for (const raw of metas ?? []) {
      const p = asPresence(raw);
      if (!p || p.user_id === me || !p.composing) continue;
      if (now - p.at > COMPOSING_STALE_MS) continue;
      out.add(p.user_id);
    }
  }
  return [...out].sort();
}

/** "Sara is replying" / "Sara and Omar are replying" / "3 colleagues are replying". */
export function composingSentence(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is replying to this chat`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are replying to this chat`;
  return `${names.length} colleagues are replying to this chat`;
}
