import { NextResponse, type NextRequest } from "next/server";

import { hashWebhookToken, startFromWebhook } from "@/lib/flow-engine/service";
import { checkRateLimit, clientIp, RATE_RULES, tooManyRequests } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 16 * 1024;

/**
 * Incoming-webhook trigger. The secret is the last path segment (shown once when the flow is
 * set up; only its hash is stored). The body must be a JSON object; it becomes {event.body.*}.
 * Optional `phone` (or `contact_phone`) links the run to an existing patient.
 *
 *   POST /api/flows/hooks/<token>      Idempotency-Key: <optional>
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const admin = createAdminClient();

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES)
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_BYTES)
    return NextResponse.json({ error: "payload too large" }, { status: 413 });

  const { data: flow } = await admin
    .from("flows")
    .select("*")
    .eq("webhook_token_hash", hashWebhookToken(token.slice(0, 200)))
    .eq("trigger_type", "incoming_webhook")
    .maybeSingle();
  if (!flow) {
    // Only unknown tokens are counted, so a legitimate sender is never throttled by guessers.
    const limited = await checkRateLimit(
      admin,
      "flow-hook-bad-token",
      clientIp(request.headers),
      RATE_RULES.flowWebhookBadToken,
    );
    if (!limited.allowed) return tooManyRequests(limited);
    return NextResponse.json({ error: "unknown webhook" }, { status: 404 });
  }

  const perFlow = await checkRateLimit(admin, "flow-hook", flow.id, RATE_RULES.flowWebhookPerFlow);
  if (!perFlow.allowed) return tooManyRequests(perFlow);
  if (flow.status !== "active")
    return NextResponse.json({ error: "flow is not active" }, { status: 409 });

  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return NextResponse.json({ error: "body must be a JSON object" }, { status: 400 });

  const result = await startFromWebhook(
    admin,
    flow,
    body as Record<string, unknown>,
    request.headers.get("idempotency-key"),
  );
  if (result.status === "skipped") {
    // A replayed Idempotency-Key is a success from the sender's point of view.
    const code =
      result.reason === "duplicate_trigger" ? 200 : result.reason === "loop_guard" ? 429 : 409;
    return NextResponse.json(
      { ok: result.reason === "duplicate_trigger", skipped: result.reason },
      { status: code },
    );
  }
  return NextResponse.json({ ok: true, run_id: result.runId }, { status: 202 });
}
