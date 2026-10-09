import { formatDistanceToNowStrict } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

import type { CardFieldKey } from "@/lib/enquiries/columns";
import { formatSlaRemaining, isSlaBreached, slaDueAt } from "@/lib/enquiries/sla";
import type { EnquiryRow } from "@/lib/enquiries/types";
import { formatPhone } from "@/lib/phone";

export function formatMoney(value: number | null): string {
  if (value === null) return "";
  return new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(value);
}

export function formatWhen(iso: string | null, timezone: string): string {
  if (!iso) return "";
  try {
    return formatInTimeZone(new Date(iso), timezone, "d MMM yyyy, HH:mm");
  } catch {
    return iso;
  }
}

export function ago(iso: string | null): string {
  if (!iso) return "";
  try {
    return `${formatDistanceToNowStrict(new Date(iso))} ago`;
  } catch {
    return "";
  }
}

/** <input type="datetime-local"> value for an instant, in the org's timezone. */
export function toLocalInput(iso: string | null, timezone: string): string {
  if (!iso) return "";
  try {
    return formatInTimeZone(new Date(iso), timezone, "yyyy-MM-dd'T'HH:mm");
  } catch {
    return "";
  }
}

/** Instant (ISO with offset) for a datetime-local value read in the org's timezone. */
export function fromLocalInput(value: string, timezone: string): string | null {
  if (!value) return null;
  try {
    return fromZonedTime(value, timezone).toISOString();
  } catch {
    return null;
  }
}

/** Display text for one configurable Kanban card field (empty string = hide). */
export function cardFieldText(key: CardFieldKey, r: EnquiryRow, timezone: string): string {
  switch (key) {
    case "phone":
      return r.phone ? formatPhone(r.phone) : "";
    case "source":
      return r.source ?? "";
    case "assignee":
      return r.assignee_name;
    case "created":
      return formatWhen(r.created_at, timezone);
    case "channel":
      return r.channel_name;
    case "location":
      return r.location_name;
    case "specialist":
      return r.specialist_name;
    case "service":
      return r.service_name;
    case "appointment":
      return formatWhen(r.appointment_at, timezone);
    case "est_value":
      return r.est_value === null ? "" : formatMoney(r.est_value);
    case "time_in_stage":
      return ago(r.stage_entered_at).replace(" ago", "");
  }
}

/** SLA chip text for open enquiries ("1 h 5 min overdue"), or null when there is nothing to show. */
export function slaChip(
  r: Pick<EnquiryRow, "status" | "stage_entered_at">,
  slaHours: number | null,
  now: Date = new Date(),
): { text: string; breached: boolean } | null {
  const due = slaDueAt(r, slaHours);
  if (!due) return null;
  return { text: formatSlaRemaining(due, now), breached: isSlaBreached(r, slaHours, now) };
}
