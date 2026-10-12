import { formatInTimeZone } from "date-fns-tz";

import type { SecuritySettings } from "@/lib/security/settings";

/**
 * Anomaly rules for Phase 15. Pure functions: the server code feeds them counts and times and decides
 * whether to raise an alert. Each rule returns a dedupe key so the same event never alerts twice
 * (security_alerts has a unique (org_id, dedupe_key)).
 */

export type AlertKind =
  "bulk_export" | "off_hours_access" | "failed_logins" | "role_change" | "bulk_api_read";

export type AlertDraft = {
  kind: AlertKind;
  userId: string | null;
  dedupeKey: string;
  summary: string;
  detail: Record<string, string | number | boolean | null>;
};

/** Minutes since midnight for "HH:MM". */
function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** True when `now` falls outside the working window in the org's timezone. Windows may wrap midnight. */
export function isOffHours(
  now: Date,
  timeZone: string,
  window: SecuritySettings["off_hours"],
): boolean {
  if (!window.enabled) return false;
  let local: string;
  try {
    local = formatInTimeZone(now, timeZone, "HH:mm");
  } catch {
    local = formatInTimeZone(now, "UTC", "HH:mm");
  }
  const t = minutes(local);
  const start = minutes(window.start);
  const end = minutes(window.end);
  if (start === end) return false; // a zero-length window means "no restriction"
  const inside = start < end ? t >= start && t < end : t >= start || t < end;
  return !inside;
}

/** Local calendar day in the org timezone, "2026-10-12". */
export function localDay(now: Date, timeZone: string): string {
  try {
    return formatInTimeZone(now, timeZone, "yyyy-MM-dd");
  } catch {
    return formatInTimeZone(now, "UTC", "yyyy-MM-dd");
  }
}

export function bulkExportAlert(
  input: {
    userId: string;
    entity: string;
    rows: number;
    exportsLastHour: number;
    now: Date;
    exportId: string;
  },
  settings: SecuritySettings,
): AlertDraft | null {
  const big = input.rows >= settings.bulk_export_rows;
  const frequent = input.exportsLastHour >= settings.bulk_export_count_per_hour;
  if (!big && !frequent) return null;
  const hour = input.now.toISOString().slice(0, 13);
  return {
    kind: "bulk_export",
    userId: input.userId,
    // A big export is its own event; a burst of small ones is one alert per user per hour.
    dedupeKey: big ? `bulk_export:${input.exportId}` : `export_burst:${input.userId}:${hour}`,
    summary: big
      ? `Large export: ${input.rows} ${input.entity} rows in one download`
      : `${input.exportsLastHour} exports in the last hour`,
    detail: { entity: input.entity, rows: input.rows, exports_last_hour: input.exportsLastHour },
  };
}

export function offHoursAlert(
  input: { userId: string; entity: string; now: Date; timeZone: string },
  settings: SecuritySettings,
): AlertDraft | null {
  if (!isOffHours(input.now, input.timeZone, settings.off_hours)) return null;
  const day = localDay(input.now, input.timeZone);
  return {
    kind: "off_hours_access",
    userId: input.userId,
    // One alert per person per local day: the first off-hours open raises it, the rest are in the access log.
    dedupeKey: `off_hours:${input.userId}:${day}`,
    summary: `Patient records opened outside working hours (${settings.off_hours.start}–${settings.off_hours.end})`,
    detail: {
      entity: input.entity,
      local_day: day,
      window: `${settings.off_hours.start}-${settings.off_hours.end}`,
    },
  };
}

export function failedLoginAlert(
  input: { subjectKey: string; userId: string | null; failures: number; now: Date },
  settings: SecuritySettings,
): AlertDraft | null {
  if (input.failures < settings.failed_login_threshold) return null;
  // Bucketed per window so a sustained attack alerts once per window, not once per attempt.
  const bucket = Math.floor(input.now.getTime() / (settings.failed_login_window_minutes * 60_000));
  return {
    kind: "failed_logins",
    userId: input.userId,
    dedupeKey: `failed_logins:${input.subjectKey}:${bucket}`,
    summary: `${input.failures} failed sign-ins in ${settings.failed_login_window_minutes} minutes`,
    detail: { failures: input.failures, window_minutes: settings.failed_login_window_minutes },
  };
}

export function roleChangeAlert(input: {
  actorId: string;
  kind: "member_role_changed" | "role_permissions_changed" | "role_created" | "role_deleted";
  targetId: string;
  roleName?: string;
  grantsFullAccess?: boolean;
  eventId: string;
}): AlertDraft {
  const label: Record<typeof input.kind, string> = {
    member_role_changed: "A member's role was changed",
    role_permissions_changed: "A role's permissions were changed",
    role_created: "A role was created",
    role_deleted: "A role was deleted",
  };
  return {
    kind: "role_change",
    userId: input.actorId,
    dedupeKey: `role_change:${input.eventId}`,
    summary: `${label[input.kind]}${input.roleName ? `: ${input.roleName}` : ""}${input.grantsFullAccess ? " (full access)" : ""}`,
    detail: {
      change: input.kind,
      target: input.targetId,
      full_access: input.grantsFullAccess ?? false,
    },
  };
}

export function bulkApiReadAlert(
  input: { apiKeyId: string; rowsLastHour: number; now: Date },
  threshold: number,
): AlertDraft | null {
  if (input.rowsLastHour < threshold) return null;
  return {
    kind: "bulk_api_read",
    userId: null,
    dedupeKey: `bulk_api_read:${input.apiKeyId}:${input.now.toISOString().slice(0, 13)}`,
    summary: `An API key read ${input.rowsLastHour} rows in the last hour`,
    detail: { api_key_id: input.apiKeyId, rows: input.rowsLastHour },
  };
}
