import { CLAIM_PROGRESS_LABEL, type ClaimProgress } from "@/lib/finance/invoice-list";
import { cn } from "@/lib/utils";

/** Theme tokens from globals.css, so the colours hold in light and dark. */
const TONE: Record<ClaimProgress, string> = {
  none: "var(--muted-foreground)",
  awaiting: "var(--viz-1)",
  partial: "var(--viz-warning)",
  settled: "var(--viz-good)",
  rejected: "var(--viz-critical)",
};

/** A coloured dot with the label in normal text: tinted, but never colour-only or low-contrast. */
export function ClaimProgressBadge({
  progress,
  className,
}: {
  progress: ClaimProgress;
  className?: string;
}) {
  const tone = TONE[progress];
  return (
    <span
      className={cn(
        "text-foreground inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        progress === "none" && "text-muted-foreground",
        className,
      )}
      style={{
        backgroundColor: `color-mix(in oklab, ${tone} 14%, transparent)`,
        borderColor: `color-mix(in oklab, ${tone} 35%, transparent)`,
      }}
    >
      <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: tone }} />
      {CLAIM_PROGRESS_LABEL[progress]}
    </span>
  );
}
