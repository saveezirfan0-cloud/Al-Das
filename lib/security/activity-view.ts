import { ACTIVITY_PERIODS, periodStart, type ActivityFilters } from "@/lib/audit-view";
import { AUTH_EVENT_TYPES } from "@/lib/security/auth-events-view";
import { toCsv } from "@/lib/csv";

/** Pure helpers for the tabs of Settings → Activity log (changes, sign-ins, record access, alerts, API reads). */

export const ACTIVITY_VIEWS = [
  { value: "changes", label: "Changes" },
  { value: "logins", label: "Sign-ins" },
  { value: "access", label: "Record access" },
  { value: "alerts", label: "Alerts" },
  { value: "api", label: "API reads" },
] as const;
export type ActivityView = (typeof ACTIVITY_VIEWS)[number]["value"];

export const ACCESS_ENTITIES = [
  "contact",
  "conversation",
  "finance_claim",
  "finance_invoice",
  "document",
  "enquiry",
  "appointment",
  "portal_record",
  "export",
  "activity_log",
] as const;
export const ACCESS_ACTIONS = ["view", "list", "search", "download", "export"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export type ViewFilters = {
  view: ActivityView;
  period: ActivityFilters["period"];
  actor: string | null;
  type: string | null; // auth event type
  entity: string | null; // access entity
  action: string | null; // access action
  page: number;
};

/** Reads untrusted query-string values; anything unexpected is dropped, never thrown. */
export function parseViewFilters(
  params: Record<string, string | string[] | undefined>,
): ViewFilters {
  const view = ACTIVITY_VIEWS.find((v) => v.value === first(params.view))?.value ?? "changes";
  const period = ACTIVITY_PERIODS.find((p) => p.value === first(params.period))?.value ?? "7d";
  const actor = first(params.actor)?.trim() ?? "";
  const type = first(params.type)?.trim() ?? "";
  const entity = first(params.entity)?.trim() ?? "";
  const action = first(params.action)?.trim() ?? "";
  const page = Number.parseInt(first(params.page) ?? "1", 10);
  return {
    view,
    period,
    actor: UUID.test(actor) ? actor : null,
    type: AUTH_EVENT_TYPES.includes(type) ? type : null,
    entity: (ACCESS_ENTITIES as readonly string[]).includes(entity) ? entity : null,
    action: (ACCESS_ACTIONS as readonly string[]).includes(action) ? action : null,
    page: Number.isFinite(page) && page > 0 && page < 10_000 ? page : 1,
  };
}

export { periodStart };

/** Query string for a link that keeps the current filters. */
export function viewQuery(filters: ViewFilters, overrides: Partial<ViewFilters> = {}): string {
  const f = { ...filters, ...overrides };
  const p = new URLSearchParams();
  p.set("view", f.view);
  p.set("period", f.period);
  if (f.actor) p.set("actor", f.actor);
  if (f.type) p.set("type", f.type);
  if (f.entity) p.set("entity", f.entity);
  if (f.action) p.set("action", f.action);
  if (f.page > 1) p.set("page", String(f.page));
  return p.toString();
}

export type AuthEventExportRow = {
  at: string;
  who: string;
  event_type: string;
  method: string | null;
  ua_family: string | null;
  ip_address: string | null;
  ip_hash: string | null;
};

export function authEventsToCsv(rows: readonly AuthEventExportRow[]): string {
  return toCsv(
    ["When (UTC)", "Who", "Event", "Method", "Device", "IP address (30 days)", "IP fingerprint"],
    rows.map((r) => [
      r.at,
      r.who,
      r.event_type,
      r.method ?? "",
      r.ua_family ?? "",
      r.ip_address ?? "",
      r.ip_hash ?? "",
    ]),
  );
}

export type AccessExportRow = {
  at: string;
  who: string;
  entity: string;
  entity_id: string | null;
  action: string;
  sampled: boolean;
  rows: number | null;
};

export function accessLogToCsv(rows: readonly AccessExportRow[]): string {
  return toCsv(
    ["When (UTC)", "Who", "What", "Record id", "Action", "Sampled", "Rows"],
    rows.map((r) => [
      r.at,
      r.who,
      r.entity,
      r.entity_id ?? "",
      r.action,
      r.sampled ? "yes" : "no",
      r.rows ?? "",
    ]),
  );
}

export type ChangeExportRow = {
  at: string;
  who: string;
  action: string;
  entity: string;
  entity_id: string | null;
};

export function changesToCsv(rows: readonly ChangeExportRow[]): string {
  return toCsv(
    ["When (UTC)", "Who", "Action", "Area", "Record id"],
    rows.map((r) => [r.at, r.who, r.action, r.entity, r.entity_id ?? ""]),
  );
}

export type AlertExportRow = { at: string; kind: string; summary: string; acknowledged: boolean };

export function alertsToCsv(rows: readonly AlertExportRow[]): string {
  return toCsv(
    ["When (UTC)", "Kind", "Summary", "Acknowledged"],
    rows.map((r) => [r.at, r.kind, r.summary, r.acknowledged ? "yes" : "no"]),
  );
}

/** Safe, descriptive file name. */
export function exportFileName(view: ActivityView, now = new Date()): string {
  return `activity-${view}-${now.toISOString().slice(0, 10)}.csv`;
}

export const EXPORT_MAX_ROWS = 10_000;
