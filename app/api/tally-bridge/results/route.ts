import { NextResponse } from "next/server";

import { RESULT_OUTCOMES, type ResultOutcome } from "@/lib/accounting/tally/bridge";
import {
  applyResult,
  MAX_RESULT_BODY,
  recordBridgeCall,
  ResultError,
} from "@/lib/accounting/tally/bridge-server";
import { authenticateConnector, NO_STORE } from "@/lib/accounting/tally/bridge-route";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/tally-bridge/results { job_id, outcome, code?, parts? }: the Tally connector's answer to one job (device token,
 * see lib/accounting/tally/bridge-route.ts). Tally's own bytes come gzip-compressed and base64-encoded in `parts`; the
 * body is capped below Vercel's request limit and the decompressed size is capped too. Only a job sent to this
 * connector and not yet answered is accepted (409 otherwise). Tally's XML is read only by lib/accounting/tally/.
 */
export async function POST(request: Request) {
  const started = Date.now();
  const admin = createAdminClient();
  const gate = await authenticateConnector(admin, request, "result", started);
  if (gate instanceof Response) return gate;
  const { orgId } = gate.auth;
  const reply = async (status: number, payload: Record<string, unknown>) => {
    await recordBridgeCall(
      admin,
      orgId,
      "result",
      status < 300 ? "ok" : status >= 500 ? "server_error" : "client_error",
      status,
      started,
    );
    return NextResponse.json(payload, { status, headers: NO_STORE });
  };
  if (Number(request.headers.get("content-length") ?? 0) > MAX_RESULT_BODY)
    return reply(413, { error: "too_large" });
  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > MAX_RESULT_BODY) return reply(413, { error: "too_large" });
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad");
    body = parsed as Record<string, unknown>;
  } catch {
    return reply(400, { error: "bad_request" });
  }
  const jobId = body.job_id;
  const outcome = body.outcome;
  if (
    typeof jobId !== "string" ||
    !UUID.test(jobId) ||
    typeof outcome !== "string" ||
    !(RESULT_OUTCOMES as readonly string[]).includes(outcome)
  )
    return reply(400, { error: "bad_request" });
  try {
    const result = await applyResult(admin, gate.auth, {
      job_id: jobId,
      outcome: outcome as ResultOutcome,
      code: typeof body.code === "string" ? body.code : undefined,
      parts: body.parts as string[] | undefined,
    });
    return reply(200, { ok: true, result });
  } catch (err) {
    if (err instanceof ResultError) return reply(err.status, { error: err.code });
    return reply(500, { error: "server_error" });
  }
}
