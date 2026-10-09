"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-runs the server component on an interval (live queues). Pauses while the tab is hidden. */
export function AutoRefresh({ seconds = 30 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}
