import { Hourglass } from "lucide-react";

/** A dashboard/report slot whose data source is not built yet. Names the phase so nothing looks broken. */
export function AwaitingCard({ title, phase, detail }: { title: string; phase: string; detail?: string }) {
  return (
    <div className="text-muted-foreground flex items-start gap-3 rounded-xl border border-dashed p-4">
      <Hourglass className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 text-sm">
        <div className="text-foreground font-medium">{title}</div>
        <div>Available once {phase} is live.</div>
        {detail && <div className="mt-1 text-xs">{detail}</div>}
      </div>
    </div>
  );
}
