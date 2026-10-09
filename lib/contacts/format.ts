/**
 * Client-safe display helpers for contact data.
 */
import { formatDistanceToNowStrict } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";

export function formatDateTime(iso: string | null | undefined, timezone: string): string {
  if (!iso) return "";
  try {
    return formatInTimeZone(new Date(iso), timezone, "d MMM yyyy, HH:mm");
  } catch {
    return iso;
  }
}

export function formatDate(iso: string | null | undefined, timezone = "UTC"): string {
  if (!iso) return "";
  try {
    // date-only values must not shift with the timezone
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso))
      return formatInTimeZone(new Date(`${iso}T12:00:00Z`), "UTC", "d MMM yyyy");
    return formatInTimeZone(new Date(iso), timezone, "d MMM yyyy");
  } catch {
    return iso;
  }
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return `${formatDistanceToNowStrict(new Date(iso))} ago`;
  } catch {
    return "";
  }
}

export function displayName(c: {
  first_name: string;
  last_name: string;
  phone_e164: string | null;
  email: string | null;
}): string {
  const name = `${c.first_name} ${c.last_name}`.trim();
  return name || c.phone_e164 || c.email || "Unnamed contact";
}

export const TAG_COLORS = [
  "gray",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "indigo",
  "purple",
  "pink",
] as const;

/** Tailwind classes per tag colour (static strings so the compiler keeps them). */
export const TAG_COLOR_CLASSES: Record<string, string> = {
  gray: "bg-neutral-100 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-100",
  red: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-100",
  orange: "bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-100",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-100",
  green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-100",
  teal: "bg-teal-100 text-teal-800 dark:bg-teal-900/50 dark:text-teal-100",
  blue: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-100",
  indigo: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-100",
  purple: "bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-100",
  pink: "bg-pink-100 text-pink-800 dark:bg-pink-900/50 dark:text-pink-100",
};

export function tagClass(color: string | null | undefined): string {
  return TAG_COLOR_CLASSES[color ?? "gray"] ?? TAG_COLOR_CLASSES.gray;
}
