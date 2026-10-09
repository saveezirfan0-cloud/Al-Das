"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

export function SettingsNav({
  items,
  label = "Settings",
}: {
  items: Array<{ href: string; label: string }>;
  label?: string;
}) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="md:w-48 md:shrink-0">
      <ul className="flex gap-1 overflow-x-auto md:flex-col">
        {items.map((i) => {
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
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
