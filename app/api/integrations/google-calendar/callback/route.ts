import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { serverEnv } from "@/lib/env";
import { gcalRedirectUri } from "@/lib/integrations/gcal/config";
import { readCallback } from "@/lib/integrations/gcal/oauth";
import { finishConnect } from "@/lib/integrations/gcal/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE = "/settings/integrations/google_calendar";
const CALLBACK_RULE = { limit: 20, windowSec: 600, failOpen: false } as const;

/**
 * Google sends the person back here after they agree (Phase 20e). Signed-in only, integrations.calendar, the one-time state must
 * have been started by this same person in this workspace less than 10 minutes ago. Always redirects to the fixed settings page
 * with a short result word (never Google's text).
 */
export async function GET(request: Request) {
  const app = serverEnv().APP_URL;
  const back = (result: string) =>
    NextResponse.redirect(new URL(`${PAGE}?gcal=${encodeURIComponent(result)}`, app), 303);
  const member = await getCurrentMember();
  if (!member) return NextResponse.redirect(new URL("/login", app), 303);
  if (!can(member, "integrations.calendar")) return back("forbidden");
  const admin = createAdminClient(member.userId);
  const limit = await checkRateLimit(admin, "gcal-callback", member.userId, CALLBACK_RULE);
  if (!limit.allowed) return back("busy");
  const cb = readCallback(new URL(request.url).searchParams);
  if (!cb.ok) return back(cb.reason);
  const r = await finishConnect(admin, {
    orgId: member.orgId,
    userId: member.userId,
    state: cb.state,
    code: cb.code,
    redirectUri: gcalRedirectUri(app),
  });
  if (!r.ok) return back("failed");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "integration.google_calendar_connected",
    entity: "specialist",
    entityId: r.specialistId,
  });
  return back("connected");
}
