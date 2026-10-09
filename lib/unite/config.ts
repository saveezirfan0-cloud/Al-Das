import { z } from "zod";

/**
 * Non-secret Unite configuration, stored in integration_accounts.config. Everything that is not
 * documented by the vendor (patient and doctor endpoints, paging) is configuration, and every
 * entity sync is off until someone switches it on. Unite is READ-ONLY: nothing in lib/unite
 * writes to it, and the Finance API (sync-once, each call dequeues records) is never called.
 */
export const uniteConfigSchema = z.object({
  /** Falls back to UNITE_BASE_URL. */
  base_url: z.string().url().nullable().default(null),
  paths: z
    .object({
      authorize: z.string().min(1).default("authorize"),
      refresh: z.string().min(1).default("refreshtoken"),
      appointments: z.string().min(1).default("getallappointments"),
      /** Undocumented: leave null until the vendor confirms the endpoint. */
      patients: z.string().min(1).nullable().default(null),
      doctors: z.string().min(1).nullable().default(null),
    })
    .default({
      authorize: "authorize",
      refresh: "refreshtoken",
      appointments: "getallappointments",
      patients: null,
      doctors: null,
    }),
  /** Per-entity feature flags. All off by default. */
  enabled: z
    .object({
      appointments: z.boolean().default(false),
      patients: z.boolean().default(false),
      doctors: z.boolean().default(false),
    })
    .default({ appointments: false, patients: false, doctors: false }),
  /** Minimum gap between two calls (ms): the vendor rate limit is unknown, so stay conservative. */
  min_interval_ms: z.number().int().min(100).max(10_000).default(250),
  /** Nightly pull covers today … today + horizon_days. */
  horizon_days: z.number().int().min(1).max(31).default(7),
  /** The frequent (15 min) pull covers today … today + incremental_days. */
  incremental_days: z.number().int().min(0).max(14).default(3),
  /** Create a contact for a Unite patient we have never seen (otherwise the appointment waits unlinked). */
  create_missing_patients: z.boolean().default(true),
  /** Timezone of the date/time strings Unite sends. */
  timezone: z.string().default("Asia/Dubai"),
  /** Optional paging for the patient/doctor endpoints. */
  paging: z
    .object({
      page_param: z.string().nullable().default(null),
      page_size_param: z.string().nullable().default(null),
      page_size: z.number().int().min(10).max(1000).default(200),
      since_param: z.string().nullable().default(null),
    })
    .default({ page_param: null, page_size_param: null, page_size: 200, since_param: null }),
});

export type UniteConfig = z.infer<typeof uniteConfigSchema>;

export const DEFAULT_UNITE_CONFIG: UniteConfig = uniteConfigSchema.parse({});

export function parseUniteConfig(raw: unknown): UniteConfig {
  const parsed = uniteConfigSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_UNITE_CONFIG;
}

/** Endpoint names the client may ever call. The Finance API is refused outright. */
export function isAllowedEndpoint(config: UniteConfig, endpoint: string): boolean {
  if (/finance/i.test(endpoint)) return false;
  const allowed = [
    config.paths.authorize,
    config.paths.refresh,
    config.paths.appointments,
    config.paths.patients,
    config.paths.doctors,
  ].filter((p): p is string => !!p);
  return allowed.includes(endpoint);
}
