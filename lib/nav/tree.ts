import { can, canAny, type MemberLike } from "@/lib/auth/can";

import type { ModuleEntry, NavModules } from "./modules";

/**
 * Pure builder for the sidebar tree: top-level items, and for a registered module its sections and pages, already
 * filtered by the member's permissions. The result is plain data (no functions), so the server layout can hand it to the
 * client sidebar without a query.
 */

export type TreeTab = { href: string; label: string };
/** A page in a module's menu. `tabs` (two or more) are the sibling pages the entry stands for (a tab group). */
export type TreePage = {
  href: string;
  label: string;
  keywords?: readonly string[];
  tabs?: TreeTab[];
};
export type TreeSection = { key: string; title: string; pages: TreePage[] };

/** What the builder needs from a top-level item (NavItem satisfies it). */
export type TopItem = {
  href: string;
  permission?: string;
  permissions?: readonly string[];
  /** Lower-case role names that see the item (the same role rule as `landingPathFor`); absent = every role. */
  roles?: readonly string[];
};

export type TreeNode<T extends TopItem> = T & { sections?: TreeSection[] };

export function sectionKey(moduleHref: string, title: string): string {
  return `${moduleHref}>${title}`;
}

export function itemVisible(item: TopItem, member: MemberLike & { roleName?: string }): boolean {
  return (
    (!item.permission || can(member, item.permission)) &&
    (!item.permissions || canAny(member, item.permissions)) &&
    (!item.roles || item.roles.includes((member.roleName ?? "").trim().toLowerCase()))
  );
}

export function entryVisible(entry: ModuleEntry, member: MemberLike): boolean {
  if (entry.allow) return entry.allow(member);
  if (entry.tabs) return visibleTabs(entry, member).length > 0;
  return !!entry.permissions?.length && canAny(member, entry.permissions);
}

/** The tabs of a tab-group entry this member may open, in order. */
export function visibleTabs(entry: ModuleEntry, member: MemberLike): TreeTab[] {
  return (entry.tabs ?? [])
    .filter((t) =>
      t.allow ? t.allow(member) : t.permissions.length > 0 && canAny(member, t.permissions),
    )
    .map((t) => ({ href: t.href, label: t.label }));
}

/** Where an entry opens for this member: its first visible tab, or its own href. */
export function entryHref(entry: ModuleEntry, member: MemberLike): string {
  return visibleTabs(entry, member)[0]?.href ?? entry.href;
}

/** A module's visible pages grouped by section, sections in first-seen order, pages in list order. */
export function moduleSections(
  moduleHref: string,
  entries: readonly ModuleEntry[],
  member: MemberLike,
): TreeSection[] {
  const sections: TreeSection[] = [];
  for (const e of entries) {
    if (!entryVisible(e, member)) continue;
    let s = sections.find((x) => x.title === e.section);
    if (!s) {
      s = { key: sectionKey(moduleHref, e.section), title: e.section, pages: [] };
      sections.push(s);
    }
    const page: TreePage = { href: entryHref(e, member), label: e.label };
    if (e.keywords) page.keywords = e.keywords;
    const tabs = visibleTabs(e, member);
    if (tabs.length > 1) page.tabs = tabs;
    s.pages.push(page);
  }
  return sections;
}

/**
 * The visible tree: items the member may see, in order. A registered module carries its sections; a module whose
 * pages are all hidden is dropped (its landing page would only redirect away).
 */
export function buildNavTree<T extends TopItem>(
  items: readonly T[],
  modules: NavModules,
  member: MemberLike & { roleName?: string },
): TreeNode<T>[] {
  const out: TreeNode<T>[] = [];
  for (const item of items) {
    if (!itemVisible(item, member)) continue;
    const entries = modules[item.href];
    if (!entries) {
      out.push(item);
      continue;
    }
    const sections = moduleSections(item.href, entries, member);
    if (sections.length > 0) out.push({ ...item, sections });
  }
  return out;
}

const under = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(href + "/");

/** The current URL's query: a string ("?tab=x" or "tab=x") or anything with `get` (URLSearchParams, useSearchParams). */
export type SearchLike = string | { get(name: string): string | null } | null | undefined;

/**
 * How specifically `href` matches the current location: -1 when it does not, else a score where longer is more
 * specific. A plain href matches its own path and every path below it. An href with a query (the CRM "Branches" entry,
 * /settings/appointments?tab=locations) matches only its exact path with every one of its parameters set to the same
 * value, and then beats the plain href of that path.
 */
export function hrefMatch(href: string, pathname: string, search?: SearchLike): number {
  const q = href.indexOf("?");
  if (q < 0) return under(pathname, href) ? href.length : -1;
  if (pathname !== href.slice(0, q)) return -1;
  const have =
    typeof search === "string" ? new URLSearchParams(search) : (search ?? new URLSearchParams());
  let ok = true;
  new URLSearchParams(href.slice(q + 1)).forEach((value, key) => {
    if (have.get(key) !== value) ok = false;
  });
  return ok ? href.length : -1;
}

/**
 * The top-level item a path sits under: the most specific matching href (`hrefMatch`), so /dashboard/management is
 * Management (not Dashboard) and /staff/rota is Rota (not Staff). The top bar's title uses it.
 */
export function currentItem<T extends { href: string }>(
  items: readonly T[],
  pathname: string,
  search?: SearchLike,
): T | undefined {
  let node: T | undefined;
  let score = -1;
  for (const n of items) {
    const m = hrefMatch(n.href, pathname, search);
    if (m > score) {
      node = n;
      score = m;
    }
  }
  return node;
}

export type ActiveTrail = { item?: string; module?: string; section?: string; page?: string };

/**
 * Where the current location sits in the tree. The most specific module page wins, wherever it is listed (a Settings
 * entry can live under /finance, and a tab group's entry stands for each of its tabs); otherwise the most specific
 * top-level item. An entry whose href carries a query is active only when the current URL has the same path and the
 * same parameter values (`hrefMatch`).
 */
export function activeTrail(
  tree: ReadonlyArray<{ href: string; sections?: readonly TreeSection[] }>,
  pathname: string,
  search?: SearchLike,
): ActiveTrail {
  const node = currentItem(tree, pathname, search);
  const nodeScore = node ? hrefMatch(node.href, pathname, search) : -1;
  let best: { module: string; section: string; page: string; len: number } | undefined;
  for (const n of tree)
    for (const s of n.sections ?? [])
      for (const p of s.pages)
        for (const h of [p.href, ...(p.tabs ?? []).map((t) => t.href)]) {
          const m = hrefMatch(h, pathname, search);
          if (m >= 0 && (!best || m > best.len))
            best = { module: n.href, section: s.key, page: p.href, len: m };
        }
  if (best && (!node || best.len >= nodeScore))
    return { item: best.module, module: best.module, section: best.section, page: best.page };
  if (!node) return {};
  if (!node.sections) return { item: node.href };
  return { item: node.href, module: node.href };
}

/** Every module and section key in the tree (for Expand all / Collapse all). */
export function treeKeys(
  tree: ReadonlyArray<{ href: string; sections?: readonly TreeSection[] }>,
): {
  modules: string[];
  sections: string[];
} {
  const modules: string[] = [];
  const sections: string[] = [];
  for (const n of tree) {
    if (!n.sections) continue;
    modules.push(n.href);
    for (const s of n.sections) sections.push(s.key);
  }
  return { modules, sections };
}
