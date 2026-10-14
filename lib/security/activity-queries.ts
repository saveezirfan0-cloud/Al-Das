import "server-only";

import { periodStart, type ViewFilters } from "@/lib/security/activity-view";
import type { createClient } from "@/lib/supabase/server";
import type { Tables } from "@/lib/supabase/types";

type Db = Awaited<ReturnType<typeof createClient>>;

export type AuthEventRow = Pick<
  Tables<"auth_events">,
  | "id"
  | "user_id"
  | "event_type"
  | "method"
  | "at"
  | "ua_family"
  | "ip_address"
  | "ip_hash"
  | "org_id"
>;
export type AccessRow = Pick<
  Tables<"record_access_log">,
  "id" | "user_id" | "entity" | "entity_id" | "action" | "sampled" | "detail" | "at"
>;
export type AlertRow = Pick<
  Tables<"security_alerts">,
  "id" | "kind" | "user_id" | "summary" | "detail" | "created_at" | "acknowledged_at"
>;
export type ApiReadRow = Pick<
  Tables<"api_read_log">,
  "api_key_id" | "resource" | "bucket" | "request_count" | "row_count"
>;

/**
 * One page of the sign-in history. `limit` + 1 rows are requested by callers that paginate so the
 * extra row says whether another page exists. Runs as the signed-in admin (RLS applies).
 */
export async function fetchAuthEvents(
  db: Db,
  orgId: string,
  f: ViewFilters,
  range: [number, number],
): Promise<AuthEventRow[]> {
  let q = db
    .from("auth_events")
    .select("id, org_id, user_id, event_type, method, at, ua_family, ip_address, ip_hash")
    .eq("org_id", orgId)
    .order("at", { ascending: false })
    .order("id", { ascending: false })
    .range(range[0], range[1]);
  const since = periodStart(f.period);
  if (since) q = q.gte("at", since);
  if (f.actor) q = q.eq("user_id", f.actor);
  if (f.type) q = q.eq("event_type", f.type);
  const { data } = await q;
  return data ?? [];
}

export async function fetchAccessLog(
  db: Db,
  orgId: string,
  f: ViewFilters,
  range: [number, number],
): Promise<AccessRow[]> {
  let q = db
    .from("record_access_log")
    .select("id, user_id, entity, entity_id, action, sampled, detail, at")
    .eq("org_id", orgId)
    .order("at", { ascending: false })
    .order("id", { ascending: false })
    .range(range[0], range[1]);
  const since = periodStart(f.period);
  if (since) q = q.gte("at", since);
  if (f.actor) q = q.eq("user_id", f.actor);
  if (f.entity) q = q.eq("entity", f.entity);
  if (f.action) q = q.eq("action", f.action);
  const { data } = await q;
  return data ?? [];
}

export async function fetchAlerts(
  db: Db,
  orgId: string,
  f: ViewFilters,
  range: [number, number],
): Promise<AlertRow[]> {
  let q = db
    .from("security_alerts")
    .select("id, kind, user_id, summary, detail, created_at, acknowledged_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(range[0], range[1]);
  const since = periodStart(f.period);
  if (since) q = q.gte("created_at", since);
  const { data } = await q;
  return data ?? [];
}

export async function fetchApiReads(
  db: Db,
  orgId: string,
  f: ViewFilters,
  range: [number, number],
): Promise<ApiReadRow[]> {
  let q = db
    .from("api_read_log")
    .select("api_key_id, resource, bucket, request_count, row_count")
    .eq("org_id", orgId)
    .order("bucket", { ascending: false })
    .range(range[0], range[1]);
  const since = periodStart(f.period);
  if (since) q = q.gte("bucket", since);
  const { data } = await q;
  return data ?? [];
}

/** user id → display name for the people in an org, from the signed-in admin's view. */
export async function memberNames(db: Db, orgId: string): Promise<Map<string, string>> {
  const { data } = await db
    .from("memberships")
    .select("user_id, profiles(first_name, last_name, email)")
    .eq("org_id", orgId);
  return new Map(
    (data ?? []).map((m) => {
      const p = m.profiles;
      const full = p ? `${p.first_name} ${p.last_name}`.trim() : "";
      return [m.user_id, full || p?.email || "Unknown user"] as const;
    }),
  );
}
