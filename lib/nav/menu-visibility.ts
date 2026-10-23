import { NAV_GROUPS, NAV_ITEMS, type NavGroup } from "@/components/shell/nav";
import type { MemberLike } from "@/lib/auth/can";

import { NAV_MODULES } from "./modules";
import { buildNavTree, currentItem, type TreeSection } from "./tree";

/**
 * Menu visibility (pure): which top-level menu entries are hidden, for the whole workspace (Settings, Menu:
 * `orgs.settings.menu.hidden`) and for one person (Settings, Users, Menu access: `memberships.menu_hidden`, chosen
 * when inviting through `invites.menu_hidden`).
 *
 * Hiding only ever narrows: the role's permissions still decide what a person may do, and a hidden entry disappears
 * from the rail, the phone drawer, the bottom tabs and quick search, and its pages send the person to /page-hidden
 * (lib/auth/session.ts). Values are top-level hrefs from NAV_ITEMS; anything else is dropped when read, so a renamed
 * or removed entry never leaves a stale value that hides something else.
 */

/** Always in the menu: hiding them would leave a person with no way home or no way back to these settings. */
export const ALWAYS_SHOWN: readonly string[] = ["/dashboard", "/settings"];

/** Where a page navigation to a hidden page lands (outside every menu entry, so it is never hidden itself). */
export const PAGE_HIDDEN_PATH = "/page-hidden";

export type MenuChoice = { href: string; label: string; group: NavGroup | null };

/** Every entry that can be hidden, group by group in menu order (NAV_GROUPS), then any without a group. */
export const MENU_CHOICES: readonly MenuChoice[] = [...NAV_GROUPS, null]
  .flatMap((g) => NAV_ITEMS.filter((i) => (i.group ?? null) === g))
  .filter((i) => !ALWAYS_SHOWN.includes(i.href))
  .map((i) => ({ href: i.href, label: i.label, group: i.group ?? null }));

const KNOWN = new Set(MENU_CHOICES.map((c) => c.href));

/** A stored list made safe: known hideable hrefs only, once each, in menu order. Anything else reads as nothing hidden. */
export function cleanMenuHidden(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const wanted = new Set(value.filter((v): v is string => typeof v === "string"));
  return MENU_CHOICES.filter((c) => wanted.has(c.href)).map((c) => c.href);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The workspace-wide hidden list from `orgs.settings`. */
export function readOrgMenuHidden(orgSettings: unknown): string[] {
  return cleanMenuHidden(asObject(asObject(orgSettings)?.menu)?.hidden);
}

/** `orgs.settings` with the workspace-wide hidden list replaced; every other key is kept. */
export function writeOrgMenuHidden(
  orgSettings: unknown,
  hidden: readonly string[],
): Record<string, unknown> {
  const base = { ...(asObject(orgSettings) ?? {}) };
  base.menu = { ...(asObject(base.menu) ?? {}), hidden: cleanMenuHidden(hidden) };
  return base;
}

/** What one person has hidden: the workspace's list plus their own. */
export function combinedMenuHidden(orgSettings: unknown, personal: unknown): string[] {
  const all = new Set([...readOrgMenuHidden(orgSettings), ...cleanMenuHidden(personal)]);
  return MENU_CHOICES.filter((c) => all.has(c.href)).map((c) => c.href);
}

/** True when the href is one of the hidden entries (`KNOWN` keeps a typo from hiding nothing silently). */
export function isHiddenEntry(href: string, hidden: readonly string[]): boolean {
  return KNOWN.has(href) && hidden.includes(href);
}

/**
 * The hidden menu entry a location belongs to, or null. The most specific entry wins (`currentItem`), so hiding Staff
 * leaves Rota (/staff/rota) alone and hiding Portal leaves Clinical follow-ups (/portal/follow-ups) alone. An entry
 * whose href carries a query (Branches) matches only when the search is given.
 */
export function hiddenEntryFor(
  pathname: string | null | undefined,
  hidden: readonly string[],
  search?: string,
): string | null {
  if (!pathname || hidden.length === 0) return null;
  const item = currentItem(NAV_ITEMS, pathname, search);
  return item && isHiddenEntry(item.href, hidden) ? item.href : null;
}

/** The same for a link (`/path?query`), used to drop quick-search links into hidden areas. */
export function linkIsHidden(href: string, hidden: readonly string[]): boolean {
  const q = href.indexOf("?");
  return q < 0
    ? hiddenEntryFor(href, hidden) !== null
    : hiddenEntryFor(href.slice(0, q), hidden, href.slice(q + 1)) !== null;
}

/**
 * The menu tree without hidden entries. A module page that lives under a hidden entry goes too (a Finance setup page
 * listed under Settings when Finance is hidden), and a section left empty is dropped.
 */
export function withoutHiddenEntries<T extends { href: string; sections?: TreeSection[] }>(
  tree: readonly T[],
  hidden: readonly string[],
): T[] {
  if (hidden.length === 0) return [...tree];
  return tree
    .filter((i) => !isHiddenEntry(i.href, hidden))
    .map((i) =>
      i.sections
        ? {
            ...i,
            sections: i.sections
              .map((s) => ({ ...s, pages: s.pages.filter((p) => !linkIsHidden(p.href, hidden)) }))
              .filter((s) => s.pages.length > 0),
          }
        : i,
    );
}

/**
 * The entries a role can see at all (its permissions, the role-only entries, modules with at least one page), which
 * are the ones worth offering in the invite and Menu access dialogs.
 */
export function menuChoicesFor(member: MemberLike & { roleName?: string }): MenuChoice[] {
  const visible = new Set(buildNavTree(NAV_ITEMS, NAV_MODULES, member).map((i) => i.href));
  return MENU_CHOICES.filter((c) => visible.has(c.href));
}
