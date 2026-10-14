"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { activeTabGroup, type TabGroup } from "@/lib/nav/tabs";
import { cn } from "@/lib/utils";

/**
 * The tab strip for sibling pages that share one menu entry (Phase D, e.g. Finance, Performance: Monthly summary, Daily
 * flash, Revenue...). The layout passes the member's visible groups as plain data; the strip shows only on a page that
 * belongs to a group with two or more tabs, and never on a page listed in `exclude` (setup pages under Settings).
 */
export function ModuleTabs({
  groups,
  exclude = [],
}: {
  groups: readonly TabGroup[];
  exclude?: readonly string[];
}) {
  const pathname = usePathname();
  const hit = activeTabGroup(groups, pathname, exclude);
  if (!hit) return null;
  return (
    <nav aria-label={hit.group.label} className="mb-6 border-b print:hidden">
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {hit.group.tabs.map((t) => {
          const active = t.href === hit.active;
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "focus-visible:ring-ring block rounded-t-md border-b-2 px-3 py-2 text-sm whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-inset",
                  active
                    ? "border-primary font-medium"
                    : "text-muted-foreground hover:text-foreground border-transparent",
                )}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
