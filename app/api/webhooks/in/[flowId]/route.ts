import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { tokenMatches } from "@/lib/flow-engine/webhook-token";
import { startRun } from "@/lib/flow-engine/run";
import { createFlowDeps } from "@/lib/flow-engine/supabase-deps";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";
import { toE164 } from "@/lib/whatsapp/phone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 64 * 1024;

const bodySchema = z
  .object({
    /** Patient phone in any common format (normalised to E.164, default region AE). */
    phone: z.string().max(40).optional(),
    contact_id: z.string().uuid().optional(),
    first_name: z.string().max(60).optional(),
    last_name: z.string().max(60).optional(),
    /** Free-form data exposed to the flow as {trigger.data.*}. */
    data: z.record(z.string(), z.unknown()).default({}),
  })
  .refine((b) => b.phone || b.contact_id, { message: "phone or contact_id is required" });

/**
 * POST /api/webhooks/in/<flowId>   Authorization: Bearer <token shown once when the flow was created>
 * Starts an "Incoming webhook" flow for a contact. Responds 202 quickly; the flow runs in the job queue.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ flowId: string }> }) {
  const { flowId } = await params;
  if (!z.string().uuid().safeParse(flowId).success) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const raw = await request.text();
  if (raw.length > MAX_BODY) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });

  const admin = createAdminClient();
  const { data: flow } = await admin
    .from("flows")
    .select("id, org_id, status, trigger_type, trigger_config")
    .eq("id", flowId)
    .maybeSingle();
  const auth = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? request.headers.get("x-flow-token");
  // Same answer for "no such flow" and "bad token" so flow ids cannot be probed.
  if (!flow || flow.trigger_type !== "webhook" || !tokenMatches(auth, (flow.trigger_config as Record<string, unknown>).webhook_token_hash)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (flow.status !== "active") return NextResponse.json({ error: "flow_inactive" }, { status: 409 });

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid_body" }, { status: 400 });
  const body = parsed.data;

  let contactId = body.contact_id ?? null;
  if (contactId) {
    const { data } = await admin.from("contacts").select("id").eq("id", contactId).eq("org_id", flow.org_id).is("deleted_at", null).maybeSingle();
    if (!data) return NextResponse.json({ error: "contact_not_found" }, { status: 404 });
  } else {
    const e164 = toE164(body.phone);
    if (!e164) return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
    const { data: existing } = await admin
      .from("contacts")
      .select("id")
      .eq("org_id", flow.org_id)
      .eq("phone_e164", e164)
      .is("deleted_at", null)
      .maybeSingle();
    if (existing) contactId = existing.id;
    else {
      const { data: created, error } = await admin
        .from("contacts")
        .insert({ org_id: flow.org_id, phone_e164: e164, first_name: body.first_name ?? "", last_name: body.last_name ?? "", source: "api" })
        .select("id")
        .single();
      if (error || !created) return NextResponse.json({ error: "contact_create_failed" }, { status: 500 });
      contactId = created.id;
    }
  }

  const res = await startRun(createFlowDeps(admin), {
    flowId: flow.id,
    contactId,
    conversationId: null,
    trigger: { event: "webhook", data: body.data as Json },
  });
  if (!res.started) return NextResponse.json({ error: res.reason }, { status: 409 });
  return NextResponse.json({ run_id: res.runId }, { status: 202 });
}
