"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CalendarDays,
  CheckSquare,
  Contact,
  Inbox,
  LayoutDashboard,
  Menu,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

import type { NavIcon, NavItem } from "./nav";
import { useBadgedItems } from "./shell-data";

export const OPEN_NAV_EVENT = "pulse:open-nav";

const ICONS: Partial<Record<NavIcon, LucideIcon>> = {
  dashboard: LayoutDashboard,
  inbox: Inbox,
  appointments: CalendarDays,
  tasks: CheckSquare,
  contacts: Contact,
};

/** What a phone needs within thumb reach, in this order; the rest lives under "More". */
const PRIORITY: readonly NavIcon[] = ["inbox", "appointments", "tasks", "contacts", "dashboard"];

/** Bottom tab bar for small screens. The desktop sidebar takes over from `md`. */
export function MobileTabs({ items: rawItems }: { items: readonly NavItem[] }) {
  const pathname = usePathname();
  const items = useBadgedItems(rawItems);
  const tabs = PRIORITY.map((icon) => items.find((i) => i.icon === icon))
    .filter((i): i is NavItem => !!i)
    .slice(0, 4);

  return (
    <nav
      aria-label="Quick navigation"
      className="bg-background fixed inset-x-0 bottom-0 z-30 border-t pb-[env(safe-area-inset-bottom)] md:hidden print:hidden"
    >
      <ul
        className="grid"
        style={{ gridTemplateColumns: `repeat(${tabs.length + 1}, minmax(0, 1fr))` }}
      >
        {tabs.map((item) => {
          const Icon = ICONS[item.icon];
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "focus-visible:ring-ring relative flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset",
                  active ? "text-primary" : "text-muted-foreground",
                )}
              >
                {active && (
                  <span
                    className="bg-primary absolute top-0 left-1/2 h-0.5 w-8 -translate-x-1/2 rounded-b-full"
                    aria-hidden
                  />
                )}
                <span className="relative">
                  {Icon && <Icon className="size-5" aria-hidden />}
                  {item.badge ? (
                    <span
                      className="bg-destructive absolute -top-1 -right-2 min-w-4 rounded-full px-1 text-center text-[9px] leading-4 font-semibold text-white tabular-nums"
                      aria-hidden
                    >
                      {item.badge > 99 ? "99+" : item.badge}
                    </span>
                  ) : null}
                </span>
                {item.label}
                {item.badge ? <span className="sr-only">, {item.badge} overdue</span> : null}
              </Link>
            </li>
          );
        })}
        <li>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event(OPEN_NAV_EVENT))}
            aria-haspopup="dialog"
            className="text-muted-foreground focus-visible:ring-ring flex h-14 w-full flex-col items-center justify-center gap-0.5 text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset"
          >
            <Menu className="size-5" aria-hidden />
            More
          </button>
        </li>
      </ul>
    </nav>
  );
}
