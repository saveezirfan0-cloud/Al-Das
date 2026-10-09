import { formatValue, type ValueFormat } from "@/lib/reports/format";

/** A headline number. Proportional figures at display size; the hint carries context, never color alone. */
export function KpiTile({ label, value, format = "number", hint }: { label: string; value: number | null; format?: ValueFormat; hint?: string }) {
  return (
    <div className="bg-card rounded-xl border p-4">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight">{formatValue(value, format)}</div>
      {hint && <div className="text-muted-foreground mt-0.5 text-xs">{hint}</div>}
    </div>
  );
}
