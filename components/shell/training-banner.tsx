import Link from "next/link";
import { GraduationCap } from "lucide-react";

import { TRAINING_BLOCKED_MESSAGE } from "@/lib/training/simulate";

/** Shown on every page of a training workspace. Server component: it costs nothing and cannot be dismissed. */
export function TrainingBanner() {
  return (
    <div
      role="status"
      className="flex shrink-0 items-center justify-center gap-2 bg-amber-400 px-3 py-1.5 text-center text-xs font-medium text-amber-950 print:hidden"
    >
      <GraduationCap className="size-4 shrink-0" />
      <span>TRAINING MODE · {TRAINING_BLOCKED_MESSAGE} Everything here is practice data.</span>
      <Link href="/help/training" className="underline">
        Training guides
      </Link>
    </div>
  );
}
