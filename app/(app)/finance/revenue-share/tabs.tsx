import Link from "next/link";

import { cn } from "@/lib/utils";

/** Anyone holding one of these keys may open the revenue-share pages (payouts are doctor compensation). */
export const VIEW_PERMS = [
  "finance.revshare.view",
  "finance.revshare.manage",
  "finance.revshare.verify",
  "finance.revshare.approve",
] as const;

const TABS = [
  { key: "runs", href: "/finance/revenue-share", label: "Monthly runs" },
  { key: "schemes", href: "/finance/revenue-share/schemes", label: "Schemes" },
  { key: "charges", href: "/finance/revenue-share/charges", label: "Doctor charges" },
] as const;

export function RevshareTabs({ active }: { active: (typeof TABS)[number]["key"] }) {
  return (
    <nav aria-label="Revenue share" className="flex gap-1 border-b text-sm">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? "page" : undefined}
          className={cn(
            "-mb-px border-b-2 px-3 py-2",
            t.key === active
              ? "border-primary font-medium"
              : "text-muted-foreground hover:text-foreground border-transparent",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
