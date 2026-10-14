import { Badge } from "@/components/ui/badge";
import { expiryBadge } from "@/lib/organisation/expiry";

/** A visa or licence expiry chip: warning within the reminder days, destructive once expired, nothing without a date. */
export function ExpiryBadge({
  label,
  date,
  today,
  leadDays,
  showValid = false,
}: {
  /** What expires, e.g. "Visa" or "Licence"; read before the date by screen readers. */
  label: string;
  date: string | null | undefined;
  today: string;
  leadDays: number;
  /** Also show a quiet chip when the date is far away (the drawer shows it; lists stay calm). */
  showValid?: boolean;
}) {
  const b = expiryBadge(date, today, leadDays);
  if (b.state === "none") return null;
  if (b.state === "valid")
    return showValid ? (
      <Badge variant="outline">
        {label}: {b.label}
      </Badge>
    ) : null;
  return (
    <Badge variant={b.tone === "destructive" ? "destructive" : "warning"}>
      {label}: {b.label}
    </Badge>
  );
}
