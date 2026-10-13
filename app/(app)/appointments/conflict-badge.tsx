import { TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";

import type { CapacityConflict } from "./types";

/** Phase 20c: why a booking breaks today's capacity rules. Display only; nothing is refused or changed. */
export const CONFLICT_TEXT: Record<CapacityConflict, string> = {
  blocked: "Overlaps a blocked time (one-off or weekly), including service buffers.",
  full: "More bookings overlap here than the service and specialist allow, including buffers.",
};

export function ConflictIcon({
  conflict,
  className,
}: {
  conflict: CapacityConflict | null | undefined;
  className?: string;
}) {
  if (!conflict) return null;
  const text = `Booking conflict: ${CONFLICT_TEXT[conflict]}`;
  return (
    <span
      role="img"
      aria-label={text}
      title={text}
      className={cn("inline-flex shrink-0", className)}
    >
      <TriangleAlert className="size-4 text-amber-600" aria-hidden />
    </span>
  );
}
