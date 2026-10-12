"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { pullState } from "@/lib/hooks/gestures";
import { cn } from "@/lib/utils";

/**
 * Pull-to-refresh for a scrolling list on touch screens. Wraps its children; the scrollable element is found
 * with `scrollerSelector` (default: the wrapper itself). Refreshing re-runs the server data for the page
 * (router.refresh) unless `onRefresh` is given. Does nothing with a mouse.
 */
export function PullToRefresh({
  children,
  className,
  scrollerSelector,
  onRefresh,
}: {
  children: React.ReactNode;
  className?: string;
  scrollerSelector?: string;
  onRefresh?: () => Promise<void> | void;
}) {
  const router = useRouter();
  const root = useRef<HTMLDivElement>(null);
  const [pull, setPull] = useState({ distance: 0, ready: false });
  const [refreshing, setRefreshing] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let startY: number | null = null;
    let latest = { distance: 0, ready: false };
    const scroller = () =>
      scrollerSelector ? (el.querySelector<HTMLElement>(scrollerSelector) ?? el) : el;

    const onStart = (e: TouchEvent) => {
      if (busy.current || e.touches.length !== 1) return;
      startY = scroller().scrollTop <= 0 ? e.touches[0].clientY : null;
    };
    const onMove = (e: TouchEvent) => {
      if (startY === null) return;
      latest = pullState({
        startY,
        currentY: e.touches[0].clientY,
        scrollTop: scroller().scrollTop,
      });
      if (latest.distance > 0 && e.cancelable) e.preventDefault(); // we own this drag: stop the page from rubber-banding
      setPull(latest);
    };
    const onEnd = async () => {
      if (startY === null) return;
      startY = null;
      const go = latest.ready;
      latest = { distance: 0, ready: false };
      setPull(latest);
      if (!go || busy.current) return;
      busy.current = true;
      setRefreshing(true);
      try {
        if (onRefresh) await onRefresh();
        else router.refresh();
        await new Promise((r) => setTimeout(r, 600)); // router.refresh() resolves immediately; keep the spinner visible briefly
      } finally {
        busy.current = false;
        setRefreshing(false);
      }
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [router, onRefresh, scrollerSelector]);

  const shown = refreshing ? 40 : pull.distance;
  return (
    <div ref={root} className={cn("relative flex min-h-0 flex-col", className)}>
      <div
        className="text-muted-foreground pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-center overflow-hidden transition-[height] duration-150"
        style={{ height: shown }}
        aria-hidden={!refreshing}
        role={refreshing ? "status" : undefined}
      >
        {refreshing ? (
          <Loader2 className="size-5 animate-spin" aria-label="Refreshing" />
        ) : (
          <RefreshCw className={cn("size-5 transition-transform", pull.ready && "rotate-180")} />
        )}
      </div>
      <div
        className="flex min-h-0 flex-1 flex-col"
        style={{
          transform: shown ? `translateY(${shown}px)` : undefined,
          transition: pull.distance ? "none" : "transform 150ms",
        }}
      >
        {children}
      </div>
    </div>
  );
}
