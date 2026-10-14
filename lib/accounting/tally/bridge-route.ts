import "server-only";

import { NextResponse } from "next/server";

import { checkRateLimit, clientIp, RATE_RULES, tooManyRequests } from "@/lib/rate-limit";
import type { AdminClient } from "@/lib/supabase/admin";

import { bearerToken, hashSecret } from "./bridge";
import { bridgeEnabled, deviceForToken, recordBridgeCall, type DeviceAuth } from "./bridge-server";

/**
 * What every connector route does first (Phase 22J): the device token (Authorization: Bearer ptb_..., only its SHA-256 is
 * compared, in the database), the per-IP limit on bad tokens, the per-device limit, and the integration switch. Unknown,
 * revoked and malformed tokens all get the same 401.
 */

export const NO_STORE = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

const TALLY_STATES = new Set(["ok", "unreachable", "no_company", "error"]);
const VERSION_RE = /^[0-9A-Za-z.+-]{1,40}$/;

export function connectorHeaders(request: Request): {
  version: string | null;
  tallyState: string | null;
} {
  const v = request.headers.get("x-bridge-version")?.trim() ?? "";
  const s = request.headers.get("x-tally-state")?.trim() ?? "";
  return { version: VERSION_RE.test(v) ? v : null, tallyState: TALLY_STATES.has(s) ? s : null };
}

export async function authenticateConnector(
  admin: AdminClient,
  request: Request,
  operation: "poll" | "result",
  startedAt: number,
): Promise<{ auth: DeviceAuth; tallyState: string | null } | Response> {
  const ip = clientIp(request.headers);
  const unauthorised = async () => {
    const limited = await checkRateLimit(
      admin,
      "tally-bridge-bad-token",
      ip,
      RATE_RULES.tallyBridgeBadToken,
    );
    if (!limited.allowed) return tooManyRequests(limited);
    return NextResponse.json({ error: "unauthorised" }, { status: 401, headers: NO_STORE });
  };
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) return unauthorised();
  const tokenHash = hashSecret(token);
  const perDevice = await checkRateLimit(
    admin,
    "tally-bridge-device",
    tokenHash,
    RATE_RULES.tallyBridgePerDevice,
  );
  if (!perDevice.allowed) return tooManyRequests(perDevice);
  const { version, tallyState } = connectorHeaders(request);
  const auth = await deviceForToken(admin, tokenHash, version, tallyState);
  if (!auth) return unauthorised();
  if (!(await bridgeEnabled(admin, auth.orgId))) {
    await recordBridgeCall(admin, auth.orgId, operation, "blocked", 403, startedAt);
    return NextResponse.json({ error: "switched_off" }, { status: 403, headers: NO_STORE });
  }
  return { auth, tallyState };
}
