import { formatInTimeZone } from "date-fns-tz";

export function formatWhen(value: string | null | undefined, timezone: string): string {
  if (!value) return "—";
  try {
    return formatInTimeZone(new Date(value), timezone, "d MMM yyyy, HH:mm");
  } catch {
    return "—";
  }
}

export function formatShortWhen(value: string | null | undefined, timezone: string): string {
  if (!value) return "";
  try {
    return formatInTimeZone(new Date(value), timezone, "d MMM, HH:mm");
  } catch {
    return "";
  }
}

/** Builds /campaigns URLs that keep the list filters while the drawer opens and closes. */
export function campaignsHref(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "" || v === "all" || (k === "page" && v === 1))
      continue;
    sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `/campaigns?${qs}` : "/campaigns";
}
