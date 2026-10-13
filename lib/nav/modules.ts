import { SETTINGS_PAGES } from "@/components/shell/settings-pages";
import type { MemberLike } from "@/lib/auth/can";
import { FINANCE_NAV } from "@/lib/finance/nav";

/**
 * Module registry for the sidebar tree, the collapsed-rail flyouts and quick search (Phase 22B).
 *
 * The key is a top-level sidebar href (an entry in `NAV_ITEMS`); the value is that module's own page list, the same list
 * its in-page menu, landing redirect and tests already use. An entry is visible when `allow(member)` says so, or, without
 * `allow`, when the member holds ANY of `permissions`. Order and `section` come from the list as written.
 *
 * Adding a module is ONE line here, e.g. for Accounting:
 *     "/accounting": ACCOUNTING_NAV,   // import { ACCOUNTING_NAV } from "@/lib/accounting/nav";
 * Then pass `mobileOnly` to its in-page `SettingsNav` (the sidebar tree replaces it on md+), and if it has badges,
 * publish them from its layout with `<PublishNavBadges>` (components/shell/nav-badges.tsx).
 */
export type ModuleEntry = {
  href: string;
  label: string;
  section: string;
  permissions?: readonly string[];
  allow?: (member: MemberLike) => boolean;
  keywords?: readonly string[];
  /** A count the module's own layout fetches; shown in the tree only while that layout publishes it. */
  badge?: string;
};

export type NavModules = Readonly<Record<string, readonly ModuleEntry[]>>;

export const NAV_MODULES: NavModules = {
  "/finance": FINANCE_NAV,
  "/settings": SETTINGS_PAGES,
};
