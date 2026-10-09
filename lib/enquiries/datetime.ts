import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

/** ISO timestamp → value for <input type="datetime-local"> in the org timezone. */
export function toLocalInput(iso: string | null | undefined, timezone: string): string {
  if (!iso) return "";
  try {
    return formatInTimeZone(new Date(iso), timezone, "yyyy-MM-dd'T'HH:mm");
  } catch {
    return "";
  }
}

/** <input type="datetime-local"> value (read as org-timezone wall time) → ISO timestamp, or null. */
export function fromLocalInput(value: string | null | undefined, timezone: string): string | null {
  if (!value) return null;
  try {
    const d = fromZonedTime(value, timezone);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}
