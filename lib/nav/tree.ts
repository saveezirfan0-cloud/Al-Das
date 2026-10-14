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
};

export type TreeNode<T extends TopItem> = T & { sections?: TreeSection[] };

export function sectionKey(moduleHref: string, title: string): string {
  return `${moduleHref}>${title}`;
}

export function itemVisible(item: TopItem, member: MemberLike): boolean {
  return (
    (!item.permission || can(member, item.permission)) &&
    (!item.permissions || canAny(member, item.permissions))
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
    .filter((t) => t.permissions.length > 0 && canAny(member, t.permissions))
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
  member: MemberLike,
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

/**
 * The top-level item a path sits under: the LONGEST matching href, so /dashboard/management is Management (not
 * Dashboard) and /staff/rota is Rota (not Staff). The top bar's title uses it.
 */
export function currentItem<T extends { href: string }>(
  items: readonly T[],
  pathname: string,
): T | undefined {
  let node: T | undefined;
  for (const n of items)
    if (under(pathname, n.href) && (!node || n.href.length > node.href.length)) node = n;
  return node;
}

export type ActiveTrail = { item?: string; module?: string; section?: string; page?: string };

/**
 * Where the current path sits in the tree. The most specific module page wins, wherever it is listed (a Settings entry
 * can live under /finance, and a tab group's entry stands for each of its tabs); otherwise the longest matching
 * top-level item.
 */
export function activeTrail(
  tree: ReadonlyArray<{ href: string; sections?: readonly TreeSection[] }>,
  pathname: string,
): ActiveTrail {
  const node = currentItem(tree, pathname);
  let best: { module: string; section: string; page: string; len: number } | undefined;
  for (const n of tree)
    for (const s of n.sections ?? [])
      for (const p of s.pages)
        for (const h of [p.href, ...(p.tabs ?? []).map((t) => t.href)])
          if (under(pathname, h) && (!best || h.length > best.len))
            best = { module: n.href, section: s.key, page: p.href, len: h.length };
  if (best && (!node || best.len >= node.href.length))
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
