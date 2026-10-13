"use client";

import { useSyncExternalStore } from "react";

/**
 * True while <html> carries the `dark` class (the app's chosen theme, which may differ from the OS).
 * Server render and first paint assume `false` (the default Light theme).
 */
export function useIsDark(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const observer = new MutationObserver(notify);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
      return () => observer.disconnect();
    },
    () => document.documentElement.classList.contains("dark"),
    () => false,
  );
}
