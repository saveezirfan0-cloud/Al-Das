import { SETTINGS_PAGES } from "@/components/shell/settings-pages";
import type { MemberLike } from "@/lib/auth/can";
import { ACCOUNTING_NAV } from "@/lib/accounting/nav";
import { FINANCE_NAV } from "@/lib/finance/nav";

/**
 * Module registry for the sidebar tree, the collapsed-rail flyouts and quick search (Phase 22B).
 *
 * The key is a top-level sidebar href (an entry in `NAV_ITEMS`); the value is that module's own page list, the same list
 * its in-page menu, landing redirect and tests already use. An entry is visible when `allow(member)` says so, or, without
 * `allow`, when the member holds ANY of `permissions`. Order and `section` come from the list as written.
 *
 * A Settings entry may live under /finance or /accounting (their setup pages, Phase D): the page keeps its URL and its
 * module's layout (finance access window), and the menu shows it under Settings.
 *
 * Adding a module is ONE line here, e.g. for Accounting:
 *     "/accounting": ACCOUNTING_NAV,   // import { ACCOUNTING_NAV } from "@/lib/accounting/nav";
 * Then pass `mobileOnly` to its in-page `SettingsNav` (the sidebar tree replaces it on md+), and if it has badges,
 * publish them from its layout with `<PublishNavBadges>` (components/shell/nav-badges.tsx).
 */
/** One page of a tab group: sibling pages shown as tabs under ONE menu entry (Phase D). */
export type ModuleTab = {
  href: string;
  label: string;
  permissions: readonly string[];
  /** When set, decides visibility instead of "any of `permissions`" (a page that needs two keys). */
  allow?: (member: MemberLike) => boolean;
};

export type ModuleEntry = {
  href: string;
  label: string;
  section: string;
  permissions?: readonly string[];
  allow?: (member: MemberLike) => boolean;
  keywords?: readonly string[];
  /** A count the module's own layout fetches; shown in the tree only while that layout publishes it. */
  badge?: string;
  /**
   * Sibling pages shown as tabs under this one entry. The entry opens the first tab the member may open and stays
   * highlighted on every tab; each tab is still listed in quick search. `href` is the first tab's, `permissions` the union.
   */
  tabs?: readonly ModuleTab[];
};

export type NavModules = Readonly<Record<string, readonly ModuleEntry[]>>;

export const NAV_MODULES: NavModules = {
  "/finance": FINANCE_NAV,
  "/accounting": ACCOUNTING_NAV,
  "/settings": SETTINGS_PAGES,
};
