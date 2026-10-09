import { z } from "zod";

/** Reporting settings in orgs.settings->'reports'. The SLA threshold is also read by v_sla_breaches_now. */
export const reportSettingsSchema = z.object({
  /** A patient message left unanswered this long (minutes) counts as an SLA breach. */
  sla_minutes: z.number().int().min(1).max(24 * 60).default(15),
});
export type ReportSettings = z.infer<typeof reportSettingsSchema>;
export const DEFAULT_REPORT_SETTINGS: ReportSettings = reportSettingsSchema.parse({});

export function readReportSettings(orgSettings: unknown): ReportSettings {
  const raw =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? (orgSettings as Record<string, unknown>).reports
      : undefined;
  const parsed = reportSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_REPORT_SETTINGS;
}

export function writeReportSettings(orgSettings: unknown, next: ReportSettings): Record<string, unknown> {
  const base =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? { ...(orgSettings as Record<string, unknown>) }
      : {};
  base.reports = reportSettingsSchema.parse(next);
  return base;
}
