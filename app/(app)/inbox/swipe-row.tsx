"use client";

import { useRef, useState } from "react";
import { Check, UserRoundCheck } from "lucide-react";

import { swipeCommit, swipeIntent, swipeOffset } from "@/lib/hooks/gestures";
import { cn } from "@/lib/utils";

/**
 * A conversation row with phone swipe actions: swipe right to take it ("Assign to me"), swipe left to close it.
 * Mouse and keyboard users get the same actions in the conversation header, so this is a shortcut, not the
 * only way. The row never swallows a vertical scroll: the gesture only starts when the drag is mostly sideways.
 */
export function SwipeRow({
  children,
  onSwipeRight,
  onSwipeLeft,
  rightLabel = "Assign to me",
  leftLabel = "Close",
  disabled,
}: {
  children: React.ReactNode;
  onSwipeRight?: () => void;
  onSwipeLeft?: () => void;
  rightLabel?: string;
  leftLabel?: string;
  disabled?: boolean;
}) {
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  const intent = useRef<ReturnType<typeof swipeIntent>>("pending");
  const swiped = useRef(false);

  const enabled = !disabled && (onSwipeRight || onSwipeLeft);
  const commit = swipeCommit(dx);

  function onTouchStart(e: React.TouchEvent) {
    if (!enabled || e.touches.length !== 1) return;
    start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    intent.current = "pending";
    swiped.current = false;
  }
  function onTouchMove(e: React.TouchEvent) {
    if (!start.current) return;
    const mx = e.touches[0].clientX - start.current.x;
    const my = e.touches[0].clientY - start.current.y;
    if (intent.current === "pending") intent.current = swipeIntent(mx, my);
    if (intent.current !== "horizontal") return;
    // Only allow a direction that has an action.
    if ((mx > 0 && !onSwipeRight) || (mx < 0 && !onSwipeLeft)) return setDx(0);
    swiped.current = true;
    setDx(swipeOffset(mx));
  }
  function onTouchEnd() {
    const action = intent.current === "horizontal" ? swipeCommit(dx) : null;
    start.current = null;
    setDx(0);
    if (action === "right") onSwipeRight?.();
    if (action === "left") onSwipeLeft?.();
  }

  return (
    <div
      className="relative overflow-hidden"
      onClickCapture={(e) =>
        swiped.current && (e.stopPropagation(), e.preventDefault(), (swiped.current = false))
      }
    >
      {enabled && (
        <>
          <div
            className={cn(
              "absolute inset-y-0 left-0 flex w-40 items-center gap-2 bg-emerald-600 pl-4 text-sm font-medium text-white",
              dx <= 0 && "invisible",
            )}
            aria-hidden
          >
            <UserRoundCheck className="size-5" /> {rightLabel}
          </div>
          <div
            className={cn(
              "absolute inset-y-0 right-0 flex w-40 items-center justify-end gap-2 bg-slate-600 pr-4 text-sm font-medium text-white",
              dx >= 0 && "invisible",
            )}
            aria-hidden
          >
            {leftLabel} <Check className="size-5" />
          </div>
        </>
      )}
      <div
        className={cn(
          "bg-background relative",
          dx === 0 && "transition-transform duration-150",
          commit && "shadow-md",
        )}
        style={{ transform: dx ? `translateX(${dx}px)` : undefined, touchAction: "pan-y" }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        {children}
      </div>
    </div>
  );
}
