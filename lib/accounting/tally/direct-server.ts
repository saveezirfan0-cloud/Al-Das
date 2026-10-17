import "server-only";

import { gzipSync } from "node:zlib";

import { applyResult, claimJobs, type DeviceAuth } from "./bridge-server";
import {
  readTallyDirectConfig,
  runDirectJob,
  TALLY_DIRECT_CALLS,
  TALLY_DIRECT_PROVIDER,
  tallyAuthHeaders,
  tallyDirectConfigProblems,
  TallySendError,
  type TallyPost,
} from "./direct";
import {
  dbBreakerStore,
  dbCallSink,
  loadAccount,
  readConfig,
  readSecrets,
  type AccountRow,
} from "@/lib/integrations/accounts";
import {
  createIntegrationClient,
  IntegrationError,
  type ClientDeps,
} from "@/lib/integrations/client";
import type { JobLogger } from "@/lib/jobs/types";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * The direct HTTPS connection to a hosted Tally (docs/44_TALLY_DIRECT_CONNECTION.md): Pulse claims the bridge's jobs as
 * its own device and sends them to the partner's address through the shared integration client (exactly that host,
 * https, no redirects, timeout, response cap, the stored circuit breaker, one integration_calls row per attempt under
 * "tally_direct", never a URL, header or body). Exports are read-only and retried; an import is a POST without an
 * idempotency key, so after a timeout or a 5xx it is never re-sent by the client: the bridge looks it up by REMOTEID first.
 */

/** Largest answer read from Tally (a full masters export of a large company is several MB). */
const MAX_ANSWER = 32 * 1024 * 1024;
/** Jobs run per scheduler pass and organisation (the claim hands out at most 5 at a time). */
const MAX_ROUNDS = 4;

/** True when the tally_bridge account chose the direct connection (no provider stored = the connector, as before). */
export function usesDirect(account: AccountRow): boolean {
  return readConfig(account).provider === TALLY_DIRECT_PROVIDER;
}

export type TallyDirect = {
  post: TallyPost;
  /** "ok" when the address answers and accepts the credentials, else why not (no data is read). */
  state: () => Promise<"ok" | "unreachable" | "error" | "auth">;
};

/** The direct connection for an account, or null when it is not the chosen provider or its settings are unusable. */
export function buildTallyDirect(
  admin: AdminClient,
  account: AccountRow,
  deps: Partial<Pick<ClientDeps, "fetchFn" | "sleep" | "now" | "sink" | "breaker">> = {},
): TallyDirect | null {
  if (!usesDirect(account)) return null;
  const config = readTallyDirectConfig(readConfig(account));
  const secret = readSecrets(account).tally_secret ?? "";
  if (!secret || tallyDirectConfigProblems(config).length > 0) return null;
  const client = createIntegrationClient({
    provider: TALLY_DIRECT_CALLS,
    allowedHosts: [new URL(config.url).hostname.toLowerCase()],
    sink: dbCallSink(admin, account.org_id),
    breaker: dbBreakerStore(admin, account.org_id, "tally_bridge"),
    maxResponseBytes: MAX_ANSWER,
    timeoutMs: 60_000,
    ...deps,
  });
  const headers = tallyAuthHeaders(config, secret);

  const post: TallyPost = async (xml, operation) => {
    const exportOnly = operation !== "tally.import_voucher";
    try {
      const res = await client.request({
        operation,
        method: "POST",
        url: config.url,
        headers: { ...headers, "Content-Type": "text/xml; charset=utf-8" },
        body: xml,
        // exports and the look-up only read; an import must never be sent twice by the client
        idempotent: exportOnly,
      });
      if (res.ok) return res.bytes;
      // a 4xx came from the gateway before Tally (sign-in, address): nothing was imported
      throw new TallySendError(res.status >= 500 ? "ambiguous" : "not_sent");
    } catch (err) {
      if (err instanceof TallySendError) throw err;
      if (err instanceof IntegrationError) {
        if (err.kind === "response_too_large") throw new TallySendError("too_large");
        if (err.kind === "blocked" || err.kind === "breaker_open" || err.kind === "rate_limited")
          throw new TallySendError("not_sent");
        throw new TallySendError(err.ambiguous || !exportOnly ? "ambiguous" : "not_sent");
      }
      throw new TallySendError("ambiguous");
    }
  };

  const state: TallyDirect["state"] = async () => {
    try {
      // Tally's server answers a GET on its root with a short "running" line; a gateway checks the sign-in first.
      const res = await client.request({
        operation: "tally.status",
        method: "GET",
        url: config.url,
        headers,
      });
      if (res.status === 401 || res.status === 403) return "auth";
      return res.ok ? "ok" : "error";
    } catch (err) {
      return err instanceof IntegrationError &&
        err.kind !== "network_error" &&
        err.kind !== "timeout"
        ? "error"
        : "unreachable";
    }
  };

  return { post, state };
}

export type DirectRunTotals = { ran: number; state: string };

/**
 * One pass for one organisation (called by runTallyBridge after the pulls and pushes were queued): records whether Tally
 * answers, then, while it does, claims and runs jobs as the organisation's direct device. Does nothing when the
 * integration is off, uses the connector, or the direct device was revoked.
 */
export async function runTallyDirect(
  admin: AdminClient,
  orgId: string,
  log: JobLogger,
  opts: { deadline?: number; direct?: TallyDirect | null } = {},
): Promise<DirectRunTotals | null> {
  const account = await loadAccount(admin, orgId, "tally_bridge");
  if (!account?.enabled || !usesDirect(account)) return null;
  const direct = opts.direct === undefined ? buildTallyDirect(admin, account) : opts.direct;
  if (!direct) {
    log.warn("accounting.tally_direct not configured");
    return { ran: 0, state: "not_configured" };
  }
  const state = await direct.state();
  const { data: deviceId, error } = await admin.rpc("acc_tally_bridge_direct_device", {
    p_org_id: orgId,
    p_tally_state: state === "auth" ? "error" : state,
  });
  if (error) throw new Error(`acc_tally_bridge_direct_device: ${error.code ?? "error"}`);
  if (!deviceId) return { ran: 0, state: "revoked" };
  if (state !== "ok") return { ran: 0, state };

  const auth: DeviceAuth = { deviceId: deviceId as string, orgId };
  let ran = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    const jobs = await claimJobs(admin, auth);
    if (jobs.length === 0) break;
    for (const job of jobs) {
      const r = await runDirectJob(job, direct.post);
      await applyResult(admin, auth, {
        job_id: job.id,
        outcome: r.outcome,
        ...(r.code ? { code: r.code } : {}),
        ...(r.answers?.length
          ? { parts: r.answers.map((a) => gzipSync(a).toString("base64")) }
          : {}),
      });
      ran++;
    }
  }
  return { ran, state };
}
