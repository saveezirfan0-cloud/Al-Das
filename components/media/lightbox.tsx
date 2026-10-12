"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Loader2, X, ZoomIn, ZoomOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { swipeCommit, swipeIntent } from "@/lib/hooks/gestures";
import { cn } from "@/lib/utils";

export type LightboxItem = { id: string; label?: string | null };

/**
 * Full-screen picture viewer: previous and next (buttons, arrow keys or a swipe), zoom, and a link to the
 * original. Addresses are loaded on demand through `loadUrl` (a short-lived signed link) and kept only in memory.
 */
export function Lightbox({
  items,
  index,
  onIndexChange,
  onClose,
  loadUrl,
}: {
  items: readonly LightboxItem[];
  index: number | null;
  onIndexChange: (i: number) => void;
  onClose: () => void;
  loadUrl: (id: string) => Promise<string | null>;
}) {
  const open = index !== null && items.length > 0;
  const cache = useRef(new Map<string, string>());
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(false);
  const touch = useRef<{ x: number; y: number } | null>(null);

  const current = open ? items[Math.min(Math.max(index, 0), items.length - 1)] : null;

  const fetchUrl = useCallback(
    async (id: string) => {
      const hit = cache.current.get(id);
      if (hit) return hit;
      const u = await loadUrl(id);
      if (u) cache.current.set(id, u);
      return u;
    },
    [loadUrl],
  );

  useEffect(() => {
    if (!current || index === null) return;
    let alive = true;
    setUrl(cache.current.get(current.id) ?? null);
    setFailed(false);
    setZoom(false);
    fetchUrl(current.id).then((u) => {
      if (!alive) return;
      if (u) setUrl(u);
      else setFailed(true);
    });
    // Warm the neighbours so next/previous feels instant.
    for (const n of [items[index + 1], items[index - 1]]) if (n) void fetchUrl(n.id);
    return () => {
      alive = false;
    };
  }, [current, index, items, fetchUrl]);

  const go = (delta: number) => {
    if (index === null) return;
    const next = index + delta;
    if (next >= 0 && next < items.length) onIndexChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="h-[100dvh] max-h-[100dvh] w-screen max-w-none gap-0 rounded-none border-0 bg-black/95 p-0 text-white sm:max-w-none"
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") go(-1);
          if (e.key === "ArrowRight") go(1);
        }}
      >
        <DialogTitle className="sr-only">Picture viewer</DialogTitle>
        <DialogDescription className="sr-only">
          Use the arrow keys or swipe to move between pictures. Press Escape to close.
        </DialogDescription>
        <div className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
          <span aria-live="polite">
            {index !== null ? index + 1 : 0} / {items.length}
            {current?.label ? <span className="ml-2 opacity-70">{current.label}</span> : null}
          </span>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="pointer-coarse:size-11 text-white hover:bg-white/10 hover:text-white"
              aria-label={zoom ? "Fit to screen" : "Zoom in"}
              onClick={() => setZoom((z) => !z)}
              disabled={!url}
            >
              {zoom ? <ZoomOut /> : <ZoomIn />}
            </Button>
            {url && (
              <Button
                asChild
                variant="ghost"
                size="icon"
                className="pointer-coarse:size-11 text-white hover:bg-white/10 hover:text-white"
              >
                <a href={url} target="_blank" rel="noreferrer" aria-label="Open the original">
                  <Download />
                </a>
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="pointer-coarse:size-11 text-white hover:bg-white/10 hover:text-white"
              aria-label="Close"
              onClick={onClose}
            >
              <X />
            </Button>
          </div>
        </div>
        <div
          className={cn(
            "relative flex min-h-0 flex-1 items-center justify-center",
            zoom ? "overflow-auto" : "overflow-hidden",
          )}
          onTouchStart={(e) => {
            const t = e.touches[0];
            touch.current = { x: t.clientX, y: t.clientY };
          }}
          onTouchEnd={(e) => {
            const start = touch.current;
            touch.current = null;
            if (!start || zoom) return;
            const t = e.changedTouches[0];
            const dx = t.clientX - start.x;
            const dy = t.clientY - start.y;
            if (swipeIntent(dx, dy) !== "horizontal") return;
            const action = swipeCommit(dx, 64);
            if (action === "left") go(1);
            if (action === "right") go(-1);
          }}
        >
          {failed ? (
            <p className="text-sm text-red-200">Could not load this picture.</p>
          ) : url ? (
            // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived storage URL
            <img
              src={url}
              alt={current?.label ?? "Picture"}
              className={cn(
                zoom
                  ? "max-w-none cursor-zoom-out"
                  : "max-h-[calc(100dvh-6rem)] max-w-full cursor-zoom-in object-contain",
              )}
              onClick={() => setZoom((z) => !z)}
              draggable={false}
            />
          ) : (
            <Loader2 className="size-6 animate-spin opacity-70" aria-label="Loading" />
          )}
          {index !== null && index > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute top-1/2 left-2 size-11 -translate-y-1/2 rounded-full bg-black/40 text-white hover:bg-black/60 hover:text-white"
              aria-label="Previous picture"
              onClick={() => go(-1)}
            >
              <ChevronLeft />
            </Button>
          )}
          {index !== null && index < items.length - 1 && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute top-1/2 right-2 size-11 -translate-y-1/2 rounded-full bg-black/40 text-white hover:bg-black/60 hover:text-white"
              aria-label="Next picture"
              onClick={() => go(1)}
            >
              <ChevronRight />
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
