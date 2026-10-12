import "server-only";

import type { NextResponse } from "next/server";

import { authenticateApiKey, requireScope, type ApiKeyContext } from "@/lib/public-api/auth";
import { apiError } from "@/lib/public-api/http";
import type { ApiKeyScope } from "@/lib/public-api/keys";
import { raiseAlert } from "@/lib/security/alerts";
import { bulkApiReadAlert } from "@/lib/security/anomaly";
import { readSecuritySettings } from "@/lib/security/settings";
import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";

type Params = Record<string, string>;

export type ApiRouteArgs = { request: Request; admin: AdminClient; ctx: ApiKeyContext; params: Params };

/**
 * Wraps a public API route: authenticate → scope check → handler, with unexpected errors turned into
 * an opaque 500 (only the error name is logged, never request content).
 */
export function apiRoute(scope: ApiKeyScope, handler: (args: ApiRouteArgs) => Promise<NextResponse>) {
  // `params` is a Promise<unknown> so the signature matches every route shape Next generates (static and [id]).
  return async (request: Request, routeCtx: { params: Promise<unknown> }): Promise<NextResponse> => {
    const admin = createAdminClient();
    const auth = await authenticateApiKey(request, admin);
    if (!auth.ok) return auth.response;
    const denied = requireScope(auth.ctx, scope);
    if (denied) return denied;
    try {
      const response = await handler({ request, admin, ctx: auth.ctx, params: ((await routeCtx.params) ?? {}) as Params });
      if (request.method === "GET" && response.status < 400) await logApiRead(admin, auth.ctx, scope, response);
      return response;
    } catch (err) {
      console.error("[public-api] unhandled error", { error: err instanceof Error ? err.name : "unknown", path: new URL(request.url).pathname });
      return apiError(500, "internal_error", "Something went wrong on our side.");
    }
  };
}

/** "contacts:read" → "contacts" */
function resourceOf(scope: string): string {
  return scope.split(":")[0].replace(/[^a-z_]/g, "").slice(0, 40) || "unknown";
}

/** Rows in a successful read: the length of `data` for a list, 1 for a single record. */
export function countRows(body: unknown): number {
  if (!body || typeof body !== "object") return 0;
  const data = (body as { data?: unknown }).data;
  if (Array.isArray(data)) return data.length;
  return "id" in (body as object) ? 1 : 0;
}

/**
 * Aggregate audit of API reads (Phase 10 gap): one counter per key, resource and hour, never per record.
 * A key that reads an unusual volume in an hour raises a security alert. Failures here never affect the
 * API response.
 */
async function logApiRead(admin: AdminClient, ctx: ApiKeyContext, scope: string, response: NextResponse): Promise<void> {
  try {
    const body = await response.clone().json().catch(() => null);
    const { data: hourRows, error } = await admin.rpc("api_read_log_hit", {
      p_org: ctx.orgId,
      p_key: ctx.keyId,
      p_resource: resourceOf(scope),
      p_rows: countRows(body),
    });
    if (error) {
      console.error("[public-api] read log failed", { code: error.code });
      return;
    }
    const total = typeof hourRows === "number" ? hourRows : 0;
    if (total < 100) return; // below any configurable threshold: skip the settings lookup
    const { data: org } = await admin.from("orgs").select("settings").eq("id", ctx.orgId).maybeSingle();
    const settings = readSecuritySettings(org?.settings);
    const draft = bulkApiReadAlert({ apiKeyId: ctx.keyId, rowsLastHour: total, now: new Date() }, settings.bulk_api_read_rows);
    if (draft) await raiseAlert(admin, ctx.orgId, draft);
  } catch (err) {
    console.error("[public-api] read log threw", { error: err instanceof Error ? err.name : "unknown" });
  }
}
