"use client";

import { useSyncExternalStore } from "react";

/** True while the media query matches. Server render and first paint assume `false` (the desktop layout). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", notify);
      return () => mq.removeEventListener("change", notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Below Tailwind's `md` breakpoint. */
export const useIsPhone = () => useMediaQuery("(max-width: 767px)");
