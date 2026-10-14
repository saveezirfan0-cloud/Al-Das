import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * What an empty list shows: what the list is for and what to do next (one action at most). Use it instead of a bare
 * "No results". `variant="filtered"` is for a list that is empty only because of the current filters.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-10 text-center",
        className,
      )}
    >
      {Icon && <Icon className="text-muted-foreground size-8" aria-hidden />}
      <p className="text-sm font-medium">{title}</p>
      {description && <div className="text-muted-foreground max-w-sm text-sm">{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** "Showing the first 500" under a capped list, so nobody mistakes it for the whole set. */
export function CappedNote({ shown, total }: { shown: number; total?: number | null }) {
  return (
    <p className="text-muted-foreground px-1 py-2 text-xs">
      {total != null && total > shown
        ? `Showing the first ${shown.toLocaleString()} of ${total.toLocaleString()}. Narrow the filters to see the rest.`
        : `Showing the first ${shown.toLocaleString()}. Narrow the filters to see the rest.`}
    </p>
  );
}
