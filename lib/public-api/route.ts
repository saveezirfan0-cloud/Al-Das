import "server-only";

import type { NextResponse } from "next/server";

import { authenticateApiKey, requireScope, type ApiKeyContext } from "@/lib/public-api/auth";
import { apiError } from "@/lib/public-api/http";
import type { ApiKeyScope } from "@/lib/public-api/keys";
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
      return await handler({ request, admin, ctx: auth.ctx, params: ((await routeCtx.params) ?? {}) as Params });
    } catch (err) {
      console.error("[public-api] unhandled error", { error: err instanceof Error ? err.name : "unknown", path: new URL(request.url).pathname });
      return apiError(500, "internal_error", "Something went wrong on our side.");
    }
  };
}
