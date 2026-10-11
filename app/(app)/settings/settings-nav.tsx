"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

export type SettingsNavItem = { href: string; label: string; section?: string; badge?: number };

export function SettingsNav({
  items,
  label = "Settings",
}: {
  items: SettingsNavItem[];
  label?: string;
}) {
  const pathname = usePathname();

  // Keep the first-seen order of sections; items without one share an untitled block.
  const sections: Array<{ title?: string; items: SettingsNavItem[] }> = [];
  for (const item of items) {
    const last = sections[sections.length - 1];
    if (last && last.title === item.section) last.items.push(item);
    else sections.push({ title: item.section, items: [item] });
  }

  return (
    <nav aria-label={label} className="md:w-52 md:shrink-0">
      <div className="flex gap-4 overflow-x-auto md:flex-col md:gap-5">
        {sections.map((section, i) => (
          <div key={section.title ?? i} className="flex shrink-0 flex-col gap-1">
            {section.title && (
              <p className="text-muted-foreground hidden px-3 text-[11px] font-semibold tracking-wide uppercase md:block">
                {section.title}
              </p>
            )}
            <ul className="flex gap-1 md:flex-col">
              {section.items.map((i) => {
                const active = pathname === i.href || pathname.startsWith(i.href + "/");
                return (
                  <li key={i.href}>
                    <Link
                      href={i.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "hover:bg-accent block rounded-md px-3 py-1.5 text-sm whitespace-nowrap",
                        active ? "bg-accent font-medium" : "text-muted-foreground",
                      )}
                    >
                      {i.label}
                      {!!i.badge && (
                        <span className="bg-destructive ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-medium text-white">
                          {i.badge > 99 ? "99+" : i.badge}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
