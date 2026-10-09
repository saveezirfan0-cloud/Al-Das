"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const TABS = [
  { href: "/recall", label: "Programmes" },
  { href: "/recall/calls", label: "Call list" },
  { href: "/recall/parallel-run", label: "Parallel run" },
];

export function RecallTabs() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 border-b" aria-label="Recall sections">
      {TABS.map((t) => (
        <Link key={t.href} href={t.href} className={cn("-mb-px border-b-2 px-3 py-2 text-sm", pathname === t.href ? "border-primary font-medium" : "text-muted-foreground hover:text-foreground border-transparent")}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
