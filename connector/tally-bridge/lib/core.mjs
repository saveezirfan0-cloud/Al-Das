// The Tally bridge connector (Phase 22J): plain Node.js 20, no dependencies.
//
//  - Talks to TallyPrime ONLY at http://127.0.0.1:<port> (the XML server on this PC; default 9000).
//  - Calls Pulse ONLY over HTTPS, outbound: GET /api/tally-bridge/jobs, POST /api/tally-bridge/results, and once
//    POST /api/tally-bridge/pair. Nothing listens on this PC.
//  - Runs the four allow-listed job types and nothing else (validate.mjs). Imports only a voucher Pulse created
//    (REMOTEID "pulse-..."), never deletes. After an import whose answer never came, the next attempt looks the voucher up
//    by REMOTEID first and sends it only when Tally does not hold it.
//  - Keeps nothing but its device token. Logs job types, outcomes and timings only (no amounts, names or XML).

import { gzipSync } from "node:zlib";

import {
  lookupRequest,
  mastersSinceRequests,
  trialBalanceRequest,
  vouchersSinceRequests,
} from "./envelopes.mjs";
import { answerHoldsVoucher, checkJob, decodeTally } from "./validate.mjs";

export const VERSION = "1.0.0";
/** The largest answer read from Tally for one request. */
export const MAX_TALLY_ANSWER = 64 * 1024 * 1024;
/** The largest result posted to Pulse (its request limit is about 4.5 MB); parts are gzip-compressed. */
export const MAX_RESULT_BODY = 4_300_000;

export class TallyError extends Error {
  constructor(code) {
    super(code);
    this.code = code; // "unreachable" | "timeout" | "too_large" | "http_error"
  }
}

const defaultLog = (event, fields = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));

function checkPulseUrl(raw, allowInsecureLocalPulse) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("The Pulse address is not a web address.");
  }
  if (u.username || u.password)
    throw new Error("The Pulse address must not hold a user name or password.");
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.protocol !== "https:" && !(allowInsecureLocalPulse && local && u.protocol === "http:"))
    throw new Error("The Pulse address must start with https://");
  return u.origin;
}

function checkPort(p) {
  const n = Number(p ?? 9000);
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    throw new Error("The Tally port must be a number from 1 to 65535.");
  return n;
}

async function readCapped(res, cap) {
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > cap) throw new TallyError("too_large");
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new TallyError("too_large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const isRefused = (err) => {
  const code = err?.cause?.code ?? err?.code;
  return code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENOTFOUND";
};

/**
 * @param {{ pulseUrl: string, token?: string | null, tallyPort?: number, fetchImpl?: typeof fetch,
 *           log?: (event: string, fields?: Record<string, unknown>) => void, allowInsecureLocalPulse?: boolean,
 *           tallyTimeoutMs?: number, pulseTimeoutMs?: number }} options
 */
export function createBridge(options) {
  const pulse = checkPulseUrl(options.pulseUrl, options.allowInsecureLocalPulse === true);
  const tally = `http://127.0.0.1:${checkPort(options.tallyPort)}`;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const log = options.log ?? defaultLog;
  const tallyTimeout = options.tallyTimeoutMs ?? 120_000;
  const pulseTimeout = options.pulseTimeoutMs ?? 60_000;
  let token = options.token ?? null;

  /** POST one XML request to Tally; the answer's bytes (UTF-8 or UTF-16, as Tally sent them). */
  async function postTally(xml) {
    let res;
    try {
      res = await fetchImpl(tally, {
        method: "POST",
        headers: { "Content-Type": "text/xml; charset=utf-8" },
        body: xml,
        redirect: "error",
        signal: AbortSignal.timeout(tallyTimeout),
      });
    } catch (err) {
      if (isRefused(err)) throw new TallyError("unreachable");
      throw new TallyError("timeout");
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new TallyError("http_error");
    }
    try {
      return await readCapped(res, MAX_TALLY_ANSWER);
    } catch (err) {
      if (err instanceof TallyError) throw err;
      throw new TallyError("timeout");
    }
  }

  /** "ok" when Tally's XML server answers on this PC, else why not. */
  async function tallyState() {
    try {
      const res = await fetchImpl(tally, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      await res.body?.cancel().catch(() => {});
      return res.ok ? "ok" : "error";
    } catch (err) {
      return isRefused(err) ? "unreachable" : "error";
    }
  }

  async function callPulse(path, init = {}) {
    const headers = {
      "X-Bridge-Version": VERSION,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    };
    const res = await fetchImpl(`${pulse}${path}`, {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(pulseTimeout),
    });
    const text = new TextDecoder().decode(await readCapped(res, 8 * 1024 * 1024));
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  /** Trades a pairing code for the device token (returned once; the caller stores it). */
  async function pair(code) {
    const { status, body } = await callPulse("/api/tally-bridge/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (status !== 200 || typeof body?.token !== "string")
      throw new Error(
        status === 429
          ? "Too many attempts; wait ten minutes."
          : "Pulse did not accept the pairing code.",
      );
    token = body.token;
    log("paired", { status });
    return { token: body.token, deviceId: body.device_id };
  }

  async function report(jobId, outcome, extra = {}) {
    let parts;
    if (extra.answers?.length) {
      parts = extra.answers.map((a) => gzipSync(a).toString("base64"));
      if (parts.reduce((n, p) => n + p.length, 0) > MAX_RESULT_BODY - 1024) {
        parts = undefined;
        outcome = outcome === "ok" || outcome === "exists" ? "error" : outcome;
        extra = { code: "too_large" };
      }
    }
    const { status } = await callPulse("/api/tally-bridge/results", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job_id: jobId,
        outcome,
        ...(extra.code ? { code: extra.code } : {}),
        ...(parts ? { parts } : {}),
      }),
    });
    return status;
  }

  async function runJob(job) {
    const started = Date.now();
    const refused = checkJob(job);
    if (refused) {
      log("job_refused", {
        type: typeof job?.type === "string" ? job.type.slice(0, 40) : null,
        reason: refused,
      });
      if (job && typeof job.id === "string") await report(job.id, "error", { code: "refused_job" });
      return "refused";
    }
    let outcome = "ok";
    try {
      if (job.type === "export_masters_since") {
        const answers = [];
        for (const req of mastersSinceRequests(job.company, job.since_alter_id))
          answers.push(await postTally(req));
        await report(job.id, "ok", { answers });
      } else if (job.type === "export_vouchers_since") {
        const answers = [];
        for (const req of vouchersSinceRequests(job.company, job.since_alter_id, job.from, job.to))
          answers.push(await postTally(req));
        await report(job.id, "ok", { answers });
      } else if (job.type === "export_trial_balance") {
        const a = await postTally(trialBalanceRequest(job.company, job.as_at));
        await report(job.id, "ok", { answers: [a] });
      } else {
        outcome = await runImport(job);
      }
    } catch (err) {
      const code = err instanceof TallyError ? err.code : "error";
      if (job.type === "import_voucher") {
        // not reached: plain retry; anything else may have reached Tally, so the next attempt looks it up first
        outcome = code === "unreachable" ? "unreachable" : "timeout";
        await report(job.id, outcome, {
          code: code === "unreachable" ? "tally_unreachable" : "timeout",
        });
      } else {
        outcome = "error";
        await report(job.id, "error", {
          code:
            code === "unreachable"
              ? "tally_unreachable"
              : code === "too_large"
                ? "too_large"
                : code === "timeout"
                  ? "timeout"
                  : "error",
        });
      }
    }
    log("job", { type: job.type, outcome, ms: Date.now() - started });
    return outcome;
  }

  async function runImport(job) {
    if (job.check_first === true || job.lookup_only === true) {
      const answer = await postTally(lookupRequest(job.company, job.remote_id, job.voucher_date));
      if (answerHoldsVoucher(decodeTally(answer), job.remote_id)) {
        await report(job.id, "exists", { answers: [answer] });
        return "exists";
      }
      if (job.lookup_only === true) {
        await report(job.id, "absent");
        return "absent";
      }
    }
    const answer = await postTally(job.xml);
    await report(job.id, "ok", { answers: [answer] });
    return "ok";
  }

  /** One round: is Tally there, poll Pulse (also a heartbeat), run each job in order. */
  async function runOnce() {
    if (!token) throw new Error("Not paired yet: run `node bridge.mjs pair` first.");
    const state = await tallyState();
    const { status, body } = await callPulse("/api/tally-bridge/jobs", {
      method: "GET",
      headers: { "X-Tally-State": state },
    });
    if (status === 401)
      throw new Error("Pulse does not know this connector (revoked?). Pair it again.");
    if (status === 403) {
      log("switched_off");
      return { state, jobs: 0, pollSeconds: 300 };
    }
    if (status !== 200 || !Array.isArray(body?.jobs)) throw new Error(`Pulse answered ${status}.`);
    for (const job of body.jobs.slice(0, 10)) await runJob(job);
    const poll = Number(body.poll_seconds);
    return {
      state,
      jobs: body.jobs.length,
      pollSeconds: Number.isFinite(poll) ? Math.min(Math.max(poll, 15), 300) : 30,
    };
  }

  return { runOnce, runJob, pair, tallyState, postTally, version: VERSION };
}
