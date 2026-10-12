import { z } from "zod";

/**
 * Security settings, stored in orgs.settings->'security'. Defaults match the Phase 15 brief: five failed
 * sign-ins raise an alert, a user is dormant after 30 days, and the record access log keeps a year.
 */
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");

export const securitySettingsSchema = z.object({
  /** How long record_access_log rows are kept. The nightly purge never goes below 30 days. */
  access_log_retention_days: z.number().int().min(30).max(1825).default(365),
  /** Share of list-view opens that are logged (single-record opens and exports are always logged). */
  list_sample_rate: z.number().min(0).max(1).default(0.1),
  /** Single-record opens outside this window (org timezone) raise an alert. */
  off_hours: z
    .object({
      enabled: z.boolean().default(true),
      start: hhmm.default("07:00"),
      end: hhmm.default("21:00"),
    })
    .default({ enabled: true, start: "07:00", end: "21:00" }),
  /** One export of at least this many rows raises an alert. */
  bulk_export_rows: z.number().int().min(10).max(1_000_000).default(1000),
  /** Several exports in an hour raise an alert even when each is small. */
  bulk_export_count_per_hour: z.number().int().min(2).max(100).default(5),
  failed_login_threshold: z.number().int().min(3).max(50).default(5),
  failed_login_window_minutes: z.number().int().min(1).max(240).default(15),
  /** One API key reading this many rows in an hour raises an alert. */
  bulk_api_read_rows: z.number().int().min(100).max(10_000_000).default(5000),
  /** A member is dormant when they have not been active for this many days (access review). */
  dormant_days: z.number().int().min(7).max(365).default(30),
});

export type SecuritySettings = z.infer<typeof securitySettingsSchema>;
export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = securitySettingsSchema.parse({});

export function readSecuritySettings(orgSettings: unknown): SecuritySettings {
  const raw =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? (orgSettings as Record<string, unknown>).security
      : undefined;
  const parsed = securitySettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_SECURITY_SETTINGS;
}

export function writeSecuritySettings(
  orgSettings: unknown,
  next: SecuritySettings,
): Record<string, unknown> {
  const base =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? { ...(orgSettings as Record<string, unknown>) }
      : {};
  base.security = securitySettingsSchema.parse(next);
  return base;
}
