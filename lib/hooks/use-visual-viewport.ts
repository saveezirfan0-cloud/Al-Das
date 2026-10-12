"use client";

import { useEffect, useState } from "react";

export type ViewportBox = {
  /** Height of the area the user can actually see (shrinks while the on-screen keyboard is open). */
  height: number;
  /** How far the visible area has been pushed down from the top of the layout viewport (iOS scrolls it). */
  offsetTop: number;
  keyboardOpen: boolean;
};

/** A drop of more than this many px below the window height means the keyboard (or similar) is showing. */
const KEYBOARD_THRESHOLD = 120;

export function keyboardOpenFor(windowHeight: number, viewportHeight: number): boolean {
  return windowHeight - viewportHeight > KEYBOARD_THRESHOLD;
}

/**
 * Tracks window.visualViewport so a chat composer can stay glued above the on-screen keyboard on iOS Safari
 * and Android Chrome. Falls back to the window size where the API is missing.
 */
export function useVisualViewport(enabled = true): ViewportBox | null {
  const [box, setBox] = useState<ViewportBox | null>(null);

  useEffect(() => {
    if (!enabled) {
      setBox(null);
      return;
    }
    const vv = window.visualViewport;
    const read = () => {
      const height = vv?.height ?? window.innerHeight;
      setBox({
        height,
        offsetTop: vv?.offsetTop ?? 0,
        keyboardOpen: keyboardOpenFor(window.innerHeight, height),
      });
    };
    read();
    vv?.addEventListener("resize", read);
    vv?.addEventListener("scroll", read);
    window.addEventListener("resize", read);
    window.addEventListener("orientationchange", read);
    return () => {
      vv?.removeEventListener("resize", read);
      vv?.removeEventListener("scroll", read);
      window.removeEventListener("resize", read);
      window.removeEventListener("orientationchange", read);
    };
  }, [enabled]);

  return box;
}
