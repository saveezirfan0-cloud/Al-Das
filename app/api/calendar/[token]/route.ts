import { NextResponse } from "next/server";

import { hashFeedToken, parseFeedToken } from "@/lib/integrations/calendar/token";
import { serveFeed } from "@/lib/integrations/calendar/feed-server";
import { checkRateLimit, clientIp, RATE_RULES, tooManyRequests } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COMMON_HEADERS = {
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

/**
 * GET /api/calendar/<token>.ics: the read-only doctor calendar feed. Unauthenticated by design (a calendar app cannot sign in);
 * the 256-bit token in the path is the credential and only its hash is stored. Every request counts against a per-IP and a
 * per-token rate limit. Unknown, revoked, malformed and switched-off feeds all answer the same 404.
 */
export async function GET(request: Request, ctx: { params: Promise<{ token: string }> }) {
  const admin = createAdminClient();
  const ipLimit = await checkRateLimit(
    admin,
    "calendar-feed",
    clientIp(request.headers),
    RATE_RULES.calendarFeedPerIp,
  );
  if (!ipLimit.allowed) return tooManyRequests(ipLimit);

  const { token: segment } = await ctx.params;
  const token = parseFeedToken(segment);
  if (!token) return new NextResponse("Not found", { status: 404, headers: COMMON_HEADERS });
  const tokenLimit = await checkRateLimit(
    admin,
    "calendar-feed-token",
    hashFeedToken(token),
    RATE_RULES.calendarFeedPerToken,
  );
  if (!tokenLimit.allowed) return tooManyRequests(tokenLimit);

  const served = await serveFeed(admin, segment, {
    ifNoneMatch: request.headers.get("if-none-match"),
  });
  if (served.status === 404)
    return new NextResponse("Not found", { status: 404, headers: COMMON_HEADERS });
  const headers = {
    ...COMMON_HEADERS,
    ETag: served.etag,
    "Cache-Control": "private, max-age=300",
  };
  if (served.status === 304) return new NextResponse(null, { status: 304, headers });
  return new NextResponse(served.body, {
    status: 200,
    headers: {
      ...headers,
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="appointments.ics"',
    },
  });
}
