"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Search } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { rankQuickLinks, type QuickLink } from "@/lib/shell/quick-links";
import { cn } from "@/lib/utils";

export const OPEN_PALETTE_EVENT = "pulse:open-palette";

/** Ctrl/⌘ + K quick jump to any page the member may open. */
export function CommandPalette({ links }: { links: readonly QuickLink[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

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

  const results = useMemo(() => rankQuickLinks(query, links).slice(0, 12), [query, links]);

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && results[active]) {
      e.preventDefault();
      go(results[active].href);
    }
  }

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

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
            aria-expanded
            className="placeholder:text-muted-foreground h-12 w-full bg-transparent text-base outline-none md:text-sm"
          />
        </div>
        <ul
          id="palette-results"
          ref={listRef}
          role="listbox"
          className="max-h-80 overflow-y-auto p-1.5"
        >
          {results.length === 0 && (
            <li className="text-muted-foreground px-3 py-6 text-center text-sm">
              Nothing matches “{query}”.
            </li>
          )}
          {results.map((r, i) => (
            <li
              key={r.href}
              role="option"
              aria-selected={i === active}
              onMouseMove={() => setActive(i)}
              onClick={() => go(r.href)}
              className={cn(
                "flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-sm",
                i === active && "bg-accent",
              )}
            >
              <span className="truncate font-medium">{r.label}</span>
              <span className="text-muted-foreground flex items-center gap-2 truncate text-xs">
                {r.hint}
                {i === active && <CornerDownLeft className="size-3" aria-hidden />}
              </span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
