"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Re-runs the server components every few seconds while a campaign is moving. */
export function AutoRefresh({ active, seconds = 10 }: { active: boolean; seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [active, seconds, router]);
  return null;
}
