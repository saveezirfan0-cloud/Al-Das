import { NextResponse, type NextRequest } from "next/server";

import { serverEnv } from "@/lib/env";
import { enqueue } from "@/lib/jobs/enqueue";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";
import { verifyMetaSignature } from "@/lib/whatsapp/signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET: Meta's verification handshake (hub.mode / hub.verify_token / hub.challenge).
 */
export async function GET(request: NextRequest) {
  const env = serverEnv();
  const params = request.nextUrl.searchParams;
  if (
    params.get("hub.mode") === "subscribe" &&
    env.META_WEBHOOK_VERIFY_TOKEN &&
    params.get("hub.verify_token") === env.META_WEBHOOK_VERIFY_TOKEN
  ) {
    return new NextResponse(params.get("hub.challenge") ?? "", { status: 200 });
  }
  return NextResponse.json({ error: "verification failed" }, { status: 403 });
}

/**
 * POST: verify X-Hub-Signature-256 over the raw body → store raw in
 * webhook_events_in → pgmq.send('meta_events') → 200. Nothing else happens here
 * (CLAUDE.md rule 3); processing is the meta_events handler's job.
 */
export async function POST(request: NextRequest) {
  const env = serverEnv();
  if (!env.META_APP_SECRET) {
    return NextResponse.json({ error: "webhook not configured" }, { status: 503 });
  }
  const raw = await request.text();
  if (!verifyMetaSignature(raw, request.headers.get("x-hub-signature-256"), env.META_APP_SECRET)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: NonNullable<Json>;
  try {
    payload = JSON.parse(raw) as NonNullable<Json>;
    if (payload === null || typeof payload !== "object") throw new Error("not an object");
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("webhook_events_in")
    .insert({ source: "meta", payload })
    .select("id")
    .single();
  if (error) {
    console.error("[webhooks/meta] store failed", { code: error.code });
    return NextResponse.json({ error: "store failed" }, { status: 500 }); // Meta retries
  }
  try {
    await enqueue("meta_events", { event_id: data.id });
  } catch (err) {
    console.error("[webhooks/meta] enqueue failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    // The row is stored; the housekeeping sweep (lib/jobs/handlers/meta-events) re-queues unprocessed rows.
  }
  return NextResponse.json({ ok: true, id: data.id }, { status: 200 });
}
