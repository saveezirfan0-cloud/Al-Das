import type { Config } from "@/lib/integrations/types";

/**
 * Google Calendar two-way busy sync (Phase 20e, G7). Endpoints and shapes from Google's documentation, NOT verified against a live
 * Google account (docs/27_PHASE_20E_CHANNELS_NOTES.md).
 */
export const GOOGLE_OAUTH_HOST = "oauth2.googleapis.com";
export const GOOGLE_API_HOST = "www.googleapis.com";
/** The consent page the person's browser is sent to (a redirect, never a server call). */
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
/** Read and write events (needed to read busy times and to write the "Busy" events). Nothing else. */
export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/calendar.events"] as const;

export const GCAL_CALLBACK_PATH = "/api/integrations/google-calendar/callback";

export function gcalRedirectUri(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, "")}${GCAL_CALLBACK_PATH}`;
}

export type GcalConfig = {
  clientId: string;
  pullBusy: boolean;
  pushAppointments: boolean;
  /** How far ahead busy times are read and appointments written. */
  windowDays: number;
};

export function readGcalConfig(config: Config): GcalConfig {
  const days = Number(config.window_days);
  return {
    clientId: String(config.client_id ?? "").trim(),
    pullBusy: config.pull_busy !== "no",
    pushAppointments: config.push_appointments !== "no",
    windowDays: Number.isInteger(days) && days >= 7 && days <= 120 ? days : 60,
  };
}

/** How far back the sync looks (a block or appointment that already ended a day ago is left alone). */
export const GCAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** At most this many connections are synced per run, and this many event writes per connection, so each job stays short. */
export const GCAL_CONNECTIONS_PER_RUN = 20;
export const GCAL_WRITES_PER_CONNECTION = 40;
/** Pages of events read per pull (250 each). A calendar with more is left unchanged that run (never a partial mirror). */
export const GCAL_MAX_PAGES = 4;

/** Time until the next attempt after `failures` failures in a row: 5 minutes doubling, at most 6 hours. */
export function gcalBackoffMs(failures: number): number {
  const n = Math.max(0, Math.min(failures, 10));
  return Math.min(5 * 60_000 * 2 ** n, 6 * 60 * 60_000);
}
