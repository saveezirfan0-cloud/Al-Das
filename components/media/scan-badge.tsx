import { AlertTriangle, ShieldAlert, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { scanBadge } from "@/lib/media/scan";
import { cn } from "@/lib/utils";

/** Shows a file's malware-scan state. 'Not scanned' is flagged on purpose: it must not look like 'clean'. */
export function ScanBadge({
  status,
  className,
}: {
  status: string | null | undefined;
  className?: string;
}) {
  const b = scanBadge(status);
  const Icon = b.tone === "ok" ? ShieldCheck : b.tone === "danger" ? ShieldAlert : AlertTriangle;
  return (
    <Badge
      variant="outline"
      title={b.hint}
      className={cn(
        b.tone === "ok" && "border-emerald-300 text-emerald-700 dark:text-emerald-300",
        b.tone === "warn" &&
          "border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
        b.tone === "danger" &&
          "border-red-300 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200",
        className,
      )}
    >
      <Icon aria-hidden /> {b.label}
    </Badge>
  );
}
