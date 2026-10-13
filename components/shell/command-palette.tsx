"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Search } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  pushRecent,
  rankQuickLinks,
  withRecentFirst,
  type QuickLink,
} from "@/lib/shell/quick-links";
import { cn } from "@/lib/utils";

export const OPEN_PALETTE_EVENT = "pulse:open-palette";

/** Hrefs of recently opened pages, newest first: a per-device convenience, never relied on. */
const RECENT_KEY = "pulse-recent-pages";

function readRecent(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((h): h is string => typeof h === "string") : [];
  } catch {
    return [];
  }
}

function saveRecent(href: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(pushRecent(readRecent(), href)));
  } catch {
    // Private window or blocked storage: the palette works without it.
  }
}

const optionId = (i: number) => `palette-option-${i}`;

/** Ctrl/⌘ + K quick jump to any page the member may open. */
export function CommandPalette({ links }: { links: readonly QuickLink[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recentHrefs, setRecentHrefs] = useState<string[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) setRecentHrefs(readRecent());
  }, [open]);

  // With no query, recently opened pages come first; arrow keys walk both sections as one list.
  const { recent, results } = useMemo(() => {
    if (query.trim()) return { recent: [], results: rankQuickLinks(query, links).slice(0, 12) };
    const split = withRecentFirst(links, recentHrefs);
    const recent = split.recent.slice(0, 5);
    return { recent, results: [...recent, ...split.rest].slice(0, 12) };
  }, [query, links, recentHrefs]);
  const current = Math.max(0, Math.min(active, results.length - 1));

  function go(href: string) {
    saveRecent(href);
    setOpen(false);
    router.push(href);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(Math.min(current + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(current - 1, 0));
    } else if (e.key === "Enter" && results[current]) {
      e.preventDefault();
      go(results[current].href);
    }
  }

  useEffect(() => {
    listRef.current?.querySelector(`#${optionId(current)}`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  function renderOption(r: QuickLink, i: number) {
    return (
      <div
        key={r.href}
        id={optionId(i)}
        role="option"
        aria-selected={i === current}
        onMouseMove={() => setActive(i)}
        onClick={() => go(r.href)}
        className={cn(
          "flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-sm",
          i === current && "bg-accent text-accent-foreground",
        )}
      >
        <span className="truncate font-medium">{r.label}</span>
        <span className="text-muted-foreground flex items-center gap-2 truncate text-xs">
          {r.hint}
          {i === current && <CornerDownLeft className="size-3" aria-hidden />}
        </span>
      </div>
    );
  }

  const heading =
    "text-muted-foreground px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide uppercase";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setQuery("");
          setActive(0);
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="top-[20%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-lg"
      >
        <DialogTitle className="sr-only">Quick search</DialogTitle>
        <DialogDescription className="sr-only">
          Type to find a page. Use the arrow keys and Enter to open it.
        </DialogDescription>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="text-muted-foreground size-4 shrink-0" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Go to… (inbox, appointments, activity log)"
            aria-label="Search pages"
            aria-controls="palette-results"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-autocomplete="list"
            aria-activedescendant={results.length > 0 ? optionId(current) : undefined}
            className="placeholder:text-muted-foreground h-12 w-full bg-transparent text-base outline-none md:text-sm"
          />
        </div>
        <div
          id="palette-results"
          ref={listRef}
          role="listbox"
          aria-label="Pages"
          className="max-h-80 overflow-y-auto p-1.5"
        >
          {recent.length > 0 ? (
            <>
              <div role="group" aria-labelledby="palette-recent">
                <div id="palette-recent" role="presentation" className={heading}>
                  Recent
                </div>
                {recent.map((r, i) => renderOption(r, i))}
              </div>
              {results.length > recent.length && (
                <div role="group" aria-labelledby="palette-all">
                  <div id="palette-all" role="presentation" className={heading}>
                    All pages
                  </div>
                  {results.slice(recent.length).map((r, i) => renderOption(r, recent.length + i))}
                </div>
              )}
            </>
          ) : (
            results.map(renderOption)
          )}
        </div>
        {results.length === 0 && (
          <p className="text-muted-foreground px-3 pt-3 pb-6 text-center text-sm" role="status">
            Nothing matches “{query}”.
          </p>
        )}
        <div className="text-muted-foreground hidden items-center gap-4 border-t px-3 py-2 text-[11px] sm:flex">
          <span>
            <kbd className="bg-muted rounded px-1 font-mono">↑</kbd>{" "}
            <kbd className="bg-muted rounded px-1 font-mono">↓</kbd> to move
          </span>
          <span>
            <kbd className="bg-muted rounded px-1 font-mono">Enter</kbd> to open
          </span>
          <span>
            <kbd className="bg-muted rounded px-1 font-mono">Esc</kbd> to close
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
