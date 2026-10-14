import { cn } from "@/lib/utils";

import { checkinChip } from "./format";

/**
 * The front desk's check-in state on a diary entry (Arrived / With doctor / Done / Checked out). `short` keeps it to a
 * few letters for small blocks; the full label is always in the accessible name and the tooltip.
 */
export function CheckinBadge({
  value,
  short,
  className,
}: {
  value: string | null | undefined;
  short?: boolean;
  className?: string;
}) {
  const chip = checkinChip(value);
  if (!chip) return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded px-1 py-px text-[10px] leading-tight font-medium ring-1 ring-inset",
        chip.className,
        className,
      )}
      title={`Front desk: ${chip.label}`}
    >
      {short ? (
        <>
          <span aria-hidden>{chip.short}</span>
          <span className="sr-only">{chip.label}</span>
        </>
      ) : (
        chip.label
      )}
    </span>
  );
}
