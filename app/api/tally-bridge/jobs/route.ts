import { NextResponse } from "next/server";

import { claimJobs, POLL_SECONDS, recordBridgeCall } from "@/lib/accounting/tally/bridge-server";
import { authenticateConnector, NO_STORE } from "@/lib/accounting/tally/bridge-route";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/tally-bridge/jobs: the Tally connector's poll (device token, see lib/accounting/tally/bridge-route.ts). It
 * also says the connector is alive and whether Tally answers on its PC; jobs are handed out only while Tally does. Only
 * the four allow-listed job types exist; an import carries one complete Pulse voucher (REMOTEID pulse-...).
 */
export async function GET(request: Request) {
  const started = Date.now();
  const admin = createAdminClient();
  const gate = await authenticateConnector(admin, request, "poll", started);
  if (gate instanceof Response) return gate;
  try {
    const jobs = gate.tallyState === "ok" ? await claimJobs(admin, gate.auth) : [];
    await recordBridgeCall(admin, gate.auth.orgId, "poll", "ok", 200, started);
    return NextResponse.json(
      { jobs, poll_seconds: POLL_SECONDS },
      { status: 200, headers: NO_STORE },
    );
  } catch {
    await recordBridgeCall(admin, gate.auth.orgId, "poll", "server_error", 500, started);
    return NextResponse.json({ error: "server_error" }, { status: 500, headers: NO_STORE });
  }
}
