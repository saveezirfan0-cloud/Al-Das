import { can, canAny, type MemberLike } from "@/lib/auth/can";

import type { ModuleEntry, NavModules } from "./modules";

/**
 * Pure builder for the sidebar tree: top-level items, and for a registered module its sections and pages, already
 * filtered by the member's permissions. The result is plain data (no functions), so the server layout can hand it to the
 * client sidebar without a query.
 */

export type TreePage = { href: string; label: string; keywords?: readonly string[] };
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
  return !!entry.permissions?.length && canAny(member, entry.permissions);
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
    s.pages.push(
      e.keywords
        ? { href: e.href, label: e.label, keywords: e.keywords }
        : { href: e.href, label: e.label },
    );
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

export type ActiveTrail = { item?: string; module?: string; section?: string; page?: string };

/** Where the current path sits in the tree: the longest matching top-level item and, inside a module, page. */
export function activeTrail(
  tree: ReadonlyArray<{ href: string; sections?: readonly TreeSection[] }>,
  pathname: string,
): ActiveTrail {
  let node: (typeof tree)[number] | undefined;
  for (const n of tree)
    if (under(pathname, n.href) && (!node || n.href.length > node.href.length)) node = n;
  if (!node) return {};
  if (!node.sections) return { item: node.href };
  let best: { section: string; page: string } | undefined;
  for (const s of node.sections)
    for (const p of s.pages)
      if (under(pathname, p.href) && (!best || p.href.length > best.page.length))
        best = { section: s.key, page: p.href };
  return { item: node.href, module: node.href, ...best };
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
