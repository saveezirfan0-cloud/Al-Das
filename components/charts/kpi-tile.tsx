import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import { formatValue, type ValueFormat } from "@/lib/reports/format";
import { cn } from "@/lib/utils";

/**
 * A headline number. Proportional figures at display size; the hint carries context, never color alone.
 * With `href` the whole tile is a link; its text (label, value, hint) is the accessible name.
 */
export function KpiTile({
  label,
  value,
  format = "number",
  hint,
  href,
}: {
  label: string;
  value: number | null;
  format?: ValueFormat;
  hint?: string;
  href?: string;
}) {
  const body = (
    <>
      <div className={cn("text-muted-foreground text-xs", href && "pr-5")}>{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
        {formatValue(value, format)}
      </div>
      {hint && <div className="text-muted-foreground mt-0.5 text-xs">{hint}</div>}
    </>
  );
  const base = "bg-card rounded-xl border p-4";
  if (!href) return <div className={base}>{body}</div>;
  return (
    <Link
      href={href}
      className={cn(
        base,
        "group hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-ring relative block transition-colors outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      )}
    >
      <ArrowUpRight
        aria-hidden
        className="text-muted-foreground group-hover:text-primary absolute top-3 right-3 size-4"
      />
      {body}
    </Link>
  );
}
