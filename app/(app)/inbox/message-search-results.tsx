"use client";

import { Loader2, SearchX } from "lucide-react";

import { EmptyState } from "@/components/shell/empty-state";
import { cn } from "@/lib/utils";

import type { MessageHit } from "./work-actions";

function when(iso: string): string {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { day: "2-digit", month: "short", year: "2-digit" });
}

/** Splits a snippet around the searched text so it can be highlighted without HTML. */
function highlight(snippet: string, term: string): Array<{ text: string; hit: boolean }> {
  const t = term.trim().toLowerCase();
  if (!t) return [{ text: snippet, hit: false }];
  const out: Array<{ text: string; hit: boolean }> = [];
  let rest = snippet;
  for (let guard = 0; guard < 20 && rest; guard++) {
    const i = rest.toLowerCase().indexOf(t);
    if (i < 0) break;
    if (i > 0) out.push({ text: rest.slice(0, i), hit: false });
    out.push({ text: rest.slice(i, i + t.length), hit: true });
    rest = rest.slice(i + t.length);
  }
  if (rest) out.push({ text: rest, hit: false });
  return out;
}

/** Message-text search results (Phase F): the patient, when, and a short snippet around the match. */
export function MessageSearchResults({
  term,
  hits,
  loading,
  activeId,
  onOpen,
}: {
  term: string;
  hits: MessageHit[] | null;
  loading: boolean;
  activeId: string | null;
  onOpen: (conversationId: string) => void;
}) {
  if (loading)
    return (
      <p className="text-muted-foreground flex items-center justify-center gap-2 p-6 text-sm">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Searching messages…
      </p>
    );
  if (!hits) return null;
  if (hits.length === 0)
    return (
      <EmptyState
        icon={SearchX}
        className="m-3"
        title="No messages found"
        description="Only chats you can open are searched. Try fewer or different words."
      />
    );
  return (
    <>
      <ul className="divide-y" aria-label="Messages found">
        {hits.map((h) => (
          <li key={h.message_id}>
            <button
              type="button"
              onClick={() => onOpen(h.conversation_id)}
              aria-current={activeId === h.conversation_id ? "true" : undefined}
              className={cn(
                "hover:bg-accent/60 flex w-full flex-col gap-0.5 px-3 py-2.5 text-left",
                activeId === h.conversation_id && "bg-accent",
              )}
            >
              <span className="flex items-baseline gap-2">
                <span className="truncate text-sm font-medium">{h.contact_name}</span>
                <span className="text-muted-foreground ml-auto shrink-0 text-[11px]">
                  {when(h.at)}
                </span>
              </span>
              <span className="text-muted-foreground line-clamp-2 text-xs">
                {h.direction === "out" && <span className="opacity-70">You: </span>}
                {h.direction === "note" && <span className="opacity-70">Note: </span>}
                {highlight(h.snippet, term).map((part, i) =>
                  part.hit ? (
                    <mark
                      key={i}
                      className="text-foreground rounded-sm bg-amber-200 px-0.5 dark:bg-amber-500/30"
                    >
                      {part.text}
                    </mark>
                  ) : (
                    <span key={i}>{part.text}</span>
                  ),
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {hits.length >= 30 && (
        <p className="text-muted-foreground px-3 py-2 text-xs">
          Showing the 30 newest matches. Add a word to narrow the search.
        </p>
      )}
    </>
  );
}
