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
import {
  RECORD_KIND_LABELS,
  RECORD_SEARCH_DEBOUNCE_MS,
  RECORD_SEARCH_MIN_LENGTH,
  type RecordKind,
  type RecordResult,
} from "@/lib/shell/record-search";
import { cn } from "@/lib/utils";

import { searchRecordsAction } from "./search-actions";

export { OPEN_PALETTE_EVENT } from "@/lib/shell/palette-event";
import { OPEN_PALETTE_EVENT } from "@/lib/shell/palette-event";

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

/** One row of the palette: a page or a record. Records are never remembered as "Recent". */
type Option = { key: string; href: string; label: string; hint?: string; record?: boolean };
type Group = { id: string; title?: string; options: Option[] };

const RECORD_ORDER: readonly RecordKind[] = ["contact", "enquiry", "task"];
const NO_RECORDS: RecordResult[] = [];

/**
 * Ctrl/⌘ + K: jump to any page the member may open and, when `searchRecords` is on, find patients (name or phone),
 * enquiries (number or title) and tasks (subject) through `searchRecordsAction` (debounced, five per kind, the list
 * pages' own visibility rules). One combobox with `aria-activedescendant` over every row.
 */
export function CommandPalette({
  links,
  searchRecords = false,
}: {
  links: readonly QuickLink[];
  /** The member holds contacts.view, enquiries.view or tasks.view (the server checks each again). */
  searchRecords?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recentHrefs, setRecentHrefs] = useState<string[]>([]);
  const [records, setRecords] = useState<{ query: string; results: RecordResult[] }>({
    query: "",
    results: [],
  });
  const [searchError, setSearchError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);

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

  // Record search: wait for a pause in typing, and keep only the answer to the latest query.
  const trimmed = query.trim();
  const wantsRecords = searchRecords && open && trimmed.length >= RECORD_SEARCH_MIN_LENGTH;
  useEffect(() => {
    if (!wantsRecords) return;
    const id = ++requestId.current;
    const timer = setTimeout(async () => {
      try {
        const res = await searchRecordsAction(trimmed);
        if (id !== requestId.current) return;
        setRecords({ query: trimmed, results: res.ok ? res.results : [] });
        setSearchError(res.ok ? null : res.error);
      } catch {
        if (id === requestId.current) {
          setRecords({ query: trimmed, results: [] });
          setSearchError("Could not search records.");
        }
      }
    }, RECORD_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [wantsRecords, trimmed]);
  const recordResults = wantsRecords && records.query === trimmed ? records.results : NO_RECORDS;
  const searching = wantsRecords && records.query !== trimmed;

  // With no query, recently opened pages come first; arrow keys walk every section as one list.
  const groups = useMemo<Group[]>(() => {
    const asOption = (l: QuickLink): Option => ({
      key: `page:${l.href}`,
      href: l.href,
      label: l.label,
      hint: l.hint,
    });
    if (!trimmed) {
      const split = withRecentFirst(links, recentHrefs);
      const recent = split.recent.slice(0, 5);
      const rest = split.rest.slice(0, 12 - recent.length);
      return recent.length > 0
        ? [
            { id: "recent", title: "Recent", options: recent.map(asOption) },
            { id: "all", title: "All pages", options: rest.map(asOption) },
          ]
        : [{ id: "all", options: rest.map(asOption) }];
    }
    const pages = rankQuickLinks(query, links).slice(0, searchRecords ? 8 : 12);
    const out: Group[] = [
      { id: "pages", title: searchRecords ? "Pages" : undefined, options: pages.map(asOption) },
    ];
    for (const kind of RECORD_ORDER) {
      const rows = recordResults.filter((r) => r.kind === kind);
      if (rows.length > 0)
        out.push({
          id: kind,
          title: RECORD_KIND_LABELS[kind],
          options: rows.map((r) => ({
            key: `${r.kind}:${r.id}`,
            href: r.href,
            label: r.label,
            hint: r.hint,
            record: true,
          })),
        });
    }
    return out.filter((g) => g.options.length > 0);
  }, [trimmed, query, links, recentHrefs, recordResults, searchRecords]);
  const flat = useMemo(() => groups.flatMap((g) => g.options), [groups]);
  const current = Math.max(0, Math.min(active, flat.length - 1));

  function go(option: Option) {
    if (!option.record) saveRecent(option.href);
    setOpen(false);
    router.push(option.href);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(Math.min(current + 1, Math.max(flat.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(current - 1, 0));
    } else if (e.key === "Enter" && flat[current]) {
      e.preventDefault();
      go(flat[current]);
    }
  }

  useEffect(() => {
    listRef.current?.querySelector(`#${optionId(current)}`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  function renderOption(r: Option, i: number) {
    return (
      <div
        key={r.key}
        id={optionId(i)}
        role="option"
        aria-selected={i === current}
        onMouseMove={() => setActive(i)}
        onClick={() => go(r)}
        className={cn(
          "flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-sm",
          i === current && "bg-accent text-accent-foreground",
        )}
      >
        <span className="truncate font-medium">{r.label}</span>
        <span className="text-muted-foreground flex shrink-0 items-center gap-2 truncate text-xs">
          {r.hint}
          {i === current && <CornerDownLeft className="size-3" aria-hidden />}
        </span>
      </div>
    );
  }

  const heading =
    "text-muted-foreground px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide uppercase";

  let index = 0;
  const status = searching
    ? "Searching records…"
    : flat.length === 0
      ? `Nothing matches “${query}”.`
      : searchError;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setQuery("");
          setActive(0);
          setSearchError(null);
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="top-[20%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-lg"
      >
        <DialogTitle className="sr-only">Quick search</DialogTitle>
        <DialogDescription className="sr-only">
          {searchRecords
            ? "Type to find a page, a patient by name or phone, an enquiry by number or title, or a task. Use the arrow keys and Enter to open it."
            : "Type to find a page. Use the arrow keys and Enter to open it."}
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
            placeholder={
              searchRecords
                ? "Go to a page, or find a patient, enquiry or task…"
                : "Go to… (inbox, appointments, activity log)"
            }
            aria-label={searchRecords ? "Search pages and records" : "Search pages"}
            aria-controls="palette-results"
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-autocomplete="list"
            aria-activedescendant={flat.length > 0 ? optionId(current) : undefined}
            autoComplete="off"
            spellCheck={false}
            className="placeholder:text-muted-foreground h-12 w-full bg-transparent text-base outline-none md:text-sm"
          />
        </div>
        <div
          id="palette-results"
          ref={listRef}
          role="listbox"
          aria-label="Results"
          className="max-h-96 overflow-y-auto p-1.5"
        >
          {groups.map((g) =>
            g.title ? (
              <div key={g.id} role="group" aria-labelledby={`palette-${g.id}`}>
                <div id={`palette-${g.id}`} role="presentation" className={heading}>
                  {g.title}
                </div>
                {g.options.map((o) => renderOption(o, index++))}
              </div>
            ) : (
              g.options.map((o) => renderOption(o, index++))
            ),
          )}
        </div>
        {status && (
          <p
            className="text-muted-foreground px-3 pt-3 pb-6 text-center text-sm"
            role="status"
            aria-live="polite"
          >
            {status}
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
