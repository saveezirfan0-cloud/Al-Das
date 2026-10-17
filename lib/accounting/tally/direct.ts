// The Tally bridge's direct HTTPS connection (pure): the settings, and one job run against Tally.
//
// The Phase 22J connector runs on the Tally PC and talks to Tally on 127.0.0.1. When Tally is hosted (a Tally partner's
// cloud server, TallyPrime Server behind a gateway) the partner gives an https address and credentials instead, and Pulse
// sends the same four allow-listed jobs itself (docs/44_TALLY_DIRECT_CONNECTION.md). Everything else is the bridge's:
// the jobs come from acc_tally_bridge_claim, each answer goes through applyResult, an import whose answer never came is
// looked up by its REMOTEID before it is sent again, and nothing is ever deleted.
//
// Tally's own XML port has no password, so a plain http:// address, an IP literal or an internal host name is refused:
// the address must be a public https host the partner protects with the credentials stored here.

import type { ConnectorJob } from "./bridge-server";
import {
  answerHoldsVoucher,
  decodeTally,
  lookupRequest,
  mastersSinceRequests,
  trialBalanceRequest,
  vouchersSinceRequests,
} from "./envelopes";
import { gatewayUrlProblem } from "@/lib/integrations/sms/http-config";
import type { Config } from "@/lib/integrations/types";

/** The provider id of the direct connection in the tally_bridge integration (the connector's is "connector"). */
export const TALLY_DIRECT_PROVIDER = "https";
/** integration_calls provider name for Pulse's own calls to Tally. */
export const TALLY_DIRECT_CALLS = "tally_direct";

export type TallyDirectAuth = "basic" | "bearer" | "header";

export type TallyDirectConfig = {
  url: string;
  auth: TallyDirectAuth;
  username: string;
  /** Header name for auth = "header" (an API key header such as X-API-Key). */
  header: string;
};

export function readTallyDirectConfig(config: Config): TallyDirectConfig {
  const s = (k: string) => (typeof config[k] === "string" ? String(config[k]).trim() : "");
  const auth = s("tally_auth");
  return {
    url: s("tally_url"),
    auth: auth === "basic" || auth === "header" ? auth : "bearer",
    username: s("tally_username"),
    header: s("tally_header") || "X-API-Key",
  };
}

const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;
const RESERVED_HEADERS = new Set([
  "host",
  "content-type",
  "content-length",
  "transfer-encoding",
  "connection",
  "cookie",
  "accept-encoding",
  "upgrade",
  "te",
  "trailer",
]);

/**
 * Why the Tally address cannot be used (null = usable). The same public-https rule as the SMS gateway (no IP literal,
 * internal name, credentials, query string or trailing dot), except that a port other than 443 is allowed: hosted
 * TallyPrime is often published on its own port behind TLS.
 */
export function tallyUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "The Tally address must be a web address.";
  }
  if (u.protocol !== "https:")
    return "The Tally address must start with https:// (Tally's own port has no password, so it is never called over plain http).";
  if (u.port) u.port = "";
  return gatewayUrlProblem(u.toString())?.replace(/gateway/g, "Tally") ?? null;
}

/** Every problem with the direct settings (empty = usable). The secret itself is checked by readiness (stored or not). */
export function tallyDirectConfigProblems(c: TallyDirectConfig): string[] {
  const out: string[] = [];
  if (!c.url) out.push("The Tally address is missing.");
  else {
    const p = tallyUrlProblem(c.url);
    if (p) out.push(p);
  }
  if (c.auth === "basic" && !c.username) out.push("Basic sign-in needs a user name.");
  if (
    c.auth === "header" &&
    (!HEADER_NAME.test(c.header) || RESERVED_HEADERS.has(c.header.toLowerCase()))
  )
    out.push("The key header must be a plain header name such as X-API-Key.");
  return out;
}

/** The sign-in header for a request (the secret is the bearer token, the Basic password or the key). */
export function tallyAuthHeaders(c: TallyDirectConfig, secret: string): Record<string, string> {
  if (c.auth === "basic")
    return { Authorization: `Basic ${Buffer.from(`${c.username}:${secret}`).toString("base64")}` };
  if (c.auth === "header") return { [c.header]: secret };
  return { Authorization: `Bearer ${secret}` };
}

// ---- running one job ------------------------------------------------------------------------------------------------

/**
 * Why a request to Tally produced no usable answer. `not_sent`: nothing reached Tally (blocked, breaker open, refused
 * before connecting, the gateway refused the sign-in); `ambiguous`: Tally may have acted (timeout, 5xx, connection lost);
 * `too_large`: the answer was over the cap.
 */
export type TallySendFailure = "not_sent" | "ambiguous" | "too_large";

export class TallySendError extends Error {
  constructor(readonly failure: TallySendFailure) {
    super(`tally ${failure}`);
    this.name = "TallySendError";
  }
}

/** Sends one XML request to Tally and returns its answer's bytes; throws TallySendError. */
export type TallyPost = (xml: string, operation: string) => Promise<Uint8Array>;

/** What the connector would have posted to /api/tally-bridge/results, with Tally's answers as raw bytes. */
export type DirectJobResult = {
  outcome: "ok" | "exists" | "absent" | "error" | "timeout" | "unreachable";
  code?: string;
  answers?: Uint8Array[];
};

/** Runs one claimed job against Tally, exactly as connector/tally-bridge/lib/core.mjs runJob does. */
export async function runDirectJob(job: ConnectorJob, post: TallyPost): Promise<DirectJobResult> {
  try {
    if (job.type === "export_masters_since") {
      const answers: Uint8Array[] = [];
      for (const req of mastersSinceRequests(job.company, job.since_alter_id))
        answers.push(await post(req, "tally.export_masters"));
      return { outcome: "ok", answers };
    }
    if (job.type === "export_vouchers_since") {
      const answers: Uint8Array[] = [];
      for (const req of vouchersSinceRequests(job.company, job.since_alter_id, job.from, job.to))
        answers.push(await post(req, "tally.export_vouchers"));
      return { outcome: "ok", answers };
    }
    if (job.type === "export_trial_balance")
      return {
        outcome: "ok",
        answers: [await post(trialBalanceRequest(job.company, job.as_at), "tally.export_tb")],
      };
    if (job.check_first || job.lookup_only) {
      const answer = await post(
        lookupRequest(job.company, job.remote_id, job.voucher_date),
        "tally.lookup",
      );
      if (answerHoldsVoucher(decodeTally(answer), job.remote_id))
        return { outcome: "exists", answers: [answer] };
      if (job.lookup_only) return { outcome: "absent" };
    }
    return { outcome: "ok", answers: [await post(job.xml, "tally.import_voucher")] };
  } catch (err) {
    const failure = err instanceof TallySendError ? err.failure : "ambiguous";
    if (job.type === "import_voucher")
      // not sent: plain retry; anything else may have reached Tally, so the next attempt looks it up first
      return failure === "not_sent"
        ? { outcome: "unreachable", code: "tally_unreachable" }
        : { outcome: "timeout", code: "timeout" };
    return {
      outcome: "error",
      code:
        failure === "not_sent"
          ? "tally_unreachable"
          : failure === "too_large"
            ? "too_large"
            : "timeout",
    };
  }
}
