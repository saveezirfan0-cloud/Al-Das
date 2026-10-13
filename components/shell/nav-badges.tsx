"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

/**
 * Counts for pages inside a sidebar module (e.g. Finance exceptions), keyed by page href. The app layout runs no query
 * for them: a module's own layout already fetches its badges server-side and publishes them here with
 * `<PublishNavBadges>`, so the sidebar tree shows them while that module is open and drops them when you leave it.
 */
type Badges = Readonly<Record<string, number>>;

const Ctx = createContext<{ badges: Badges; set: (b: Badges) => void } | null>(null);

export function NavBadgesProvider({ children }: { children: React.ReactNode }) {
  const [badges, set] = useState<Badges>({});
  const value = useMemo(() => ({ badges, set }), [badges]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNavBadges(): Badges {
  return useContext(Ctx)?.badges ?? {};
}

export function PublishNavBadges({ counts }: { counts: Badges }) {
  const set = useContext(Ctx)?.set;
  const key = JSON.stringify(counts);
  useEffect(() => {
    if (!set) return;
    set(JSON.parse(key) as Badges);
    return () => set({});
  }, [key, set]);
  return null;
}
