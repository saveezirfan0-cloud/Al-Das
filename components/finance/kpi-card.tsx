import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { aed, delta, deltaLabel, moneyCompact } from "@/lib/finance/format";

/**
 * One headline number. `goodWhen` says which direction is good, so a rise in
 * Rejected / Outstanding is not painted green.
 */
export function KpiCard({
  label,
  value,
  previous,
  goodWhen = "up",
  note,
}: {
  label: string;
  value: number;
  previous?: number | null;
  goodWhen?: "up" | "down" | "neutral";
  note?: string;
}) {
  const d = delta(value, previous);
  const good =
    d.direction === "flat" || d.direction === "none" || goodWhen === "neutral"
      ? null
      : (d.direction === "up") === (goodWhen === "up");
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 pt-6">
        <div className="text-muted-foreground text-xs">{label}</div>
        <div className="text-2xl font-semibold tabular-nums" title={aed(value)}>
          {moneyCompact(value)}
        </div>
        <div
          className={cn(
            "text-xs",
            good === null
              ? "text-muted-foreground"
              : good
                ? "text-emerald-600"
                : "text-destructive",
          )}
        >
          {d.pct === null ? "" : d.direction === "up" ? "▲ " : d.direction === "down" ? "▼ " : ""}
          {deltaLabel(d)}
        </div>
        {note && <div className="text-muted-foreground text-xs">{note}</div>}
      </CardContent>
    </Card>
  );
}
