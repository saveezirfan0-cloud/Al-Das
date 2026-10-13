import { NextResponse } from "next/server";

import {
  generateDeviceToken,
  hashSecret,
  normalisePairingCode,
} from "@/lib/accounting/tally/bridge";
import { POLL_SECONDS, recordBridgeCall } from "@/lib/accounting/tally/bridge-server";
import { connectorHeaders, NO_STORE } from "@/lib/accounting/tally/bridge-route";
import { recordAudit } from "@/lib/audit";
import { checkRateLimit, clientIp, RATE_RULES, tooManyRequests } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/tally-bridge/pair { code }: the Tally connector trades the one-time pairing code an administrator created
 * (Accounting, Setup, Tally bridge) for its device token. Unauthenticated by design (the code is the credential: about
 * 78 bits, 30 minutes, single use, only its SHA-256 stored). Every attempt counts against a per-IP limit; an unknown,
 * used or expired code gets the same 401. The token (256 bits) is returned once and only its SHA-256 is stored.
 */
export async function POST(request: Request) {
  const started = Date.now();
  const admin = createAdminClient();
  const limited = await checkRateLimit(
    admin,
    "tally-bridge-pair",
    clientIp(request.headers),
    RATE_RULES.tallyBridgePairPerIp,
  );
  if (!limited.allowed) return tooManyRequests(limited);
  if (Number(request.headers.get("content-length") ?? 0) > 2048)
    return NextResponse.json({ error: "too_large" }, { status: 413, headers: NO_STORE });
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > 2048)
      return NextResponse.json({ error: "too_large" }, { status: 413, headers: NO_STORE });
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400, headers: NO_STORE });
  }
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>).code : null;
  const code = typeof raw === "string" ? normalisePairingCode(raw) : null;
  if (!code)
    return NextResponse.json({ error: "invalid_code" }, { status: 401, headers: NO_STORE });
  const token = generateDeviceToken();
  const { data, error } = await admin.rpc("acc_tally_bridge_pair_exchange", {
    p_code_sha256: hashSecret(code),
    p_token_sha256: hashSecret(token),
    p_version: connectorHeaders(request).version ?? "",
  });
  const paired = data as { device_id: string; org_id: string } | null;
  if (error || !paired)
    return NextResponse.json({ error: "invalid_code" }, { status: 401, headers: NO_STORE });
  await recordBridgeCall(admin, paired.org_id, "pair", "ok", 200, started);
  await recordAudit(admin, {
    orgId: paired.org_id,
    userId: null,
    action: "accounting.tally_bridge.paired",
    entity: "acc_tally_devices",
    entityId: paired.device_id,
  });
  return NextResponse.json(
    { token, device_id: paired.device_id, poll_seconds: POLL_SECONDS },
    { status: 200, headers: NO_STORE },
  );
}
