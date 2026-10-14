/**
 * Pure helper for the tab strip of sibling pages under one menu entry (components/shell/module-tabs.tsx).
 */

export type TabGroup = { label: string; tabs: ReadonlyArray<{ href: string; label: string }> };

const under = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(href + "/");

/**
 * The group and tab the current path belongs to: the most specific tab href that contains the path. Nothing for a
 * group with fewer than two tabs, or when the path sits under an excluded page (a setup page listed under Settings).
 */
export function activeTabGroup(
  groups: readonly TabGroup[],
  pathname: string,
  exclude: readonly string[] = [],
): { group: TabGroup; active: string } | null {
  if (exclude.some((h) => under(pathname, h))) return null;
  let best: { group: TabGroup; active: string } | null = null;
  for (const group of groups) {
    if (group.tabs.length < 2) continue;
    for (const t of group.tabs)
      if (under(pathname, t.href) && (!best || t.href.length > best.active.length))
        best = { group, active: t.href };
  }
  return best;
}
