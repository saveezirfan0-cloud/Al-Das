import "server-only";

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";

import { isBlockedIp, parsePublicHttpsUrl, UnsafeUrlError } from "@/lib/net/url-guard";

/**
 * HTTPS client for URLs we do not control (knowledge-base pages, webhook endpoints).
 *
 * Unlike fetch(), the address that is actually connected to is validated: the custom `lookup`
 * resolves the name and rejects any private/loopback/link-local result at connection time, so a
 * DNS answer that changes between check and use (rebinding) cannot reach an internal host.
 * Redirects are never followed implicitly; callers that want them use followRedirects.
 */

export type SafeRequestOptions = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  /** Response bodies larger than this abort the request. */
  maxBytes?: number;
  /** Follow up to this many redirects, re-validating every hop (0 = never). */
  maxRedirects?: number;
};

export type SafeResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  finalUrl: string;
};

export class ResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`Response is larger than ${limit} bytes.`);
    this.name = "ResponseTooLargeError";
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** `lookup` option for https.request: resolve, then refuse non-public addresses. */
export function guardedLookup(
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: LookupCallback,
): void {
  dnsLookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as LookupAddress[];
    if (list.length === 0 || list.some((a) => isBlockedIp(a.address))) {
      return callback(new UnsafeUrlError("That address is not publicly reachable.") as NodeJS.ErrnoException, "", 0);
    }
    if (options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

function once(url: URL, opts: SafeRequestOptions): Promise<SafeResponse> {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: opts.method ?? "GET",
        headers: opts.headers,
        lookup: guardedLookup as never,
        timeout: opts.timeoutMs ?? 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new ResponseTooLargeError(maxBytes));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") headers[k.toLowerCase()] = v;
            else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(", ");
          }
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks), finalUrl: url.toString() });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("Request timed out.")));
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export async function safeRequest(rawUrl: string, opts: SafeRequestOptions = {}): Promise<SafeResponse> {
  let url = parsePublicHttpsUrl(rawUrl);
  const maxRedirects = opts.maxRedirects ?? 0;
  for (let hop = 0; ; hop++) {
    const res = await once(url, hop === 0 ? opts : { ...opts, method: "GET", body: undefined });
    const location = res.headers["location"];
    if (res.status >= 300 && res.status < 400 && location && hop < maxRedirects) {
      url = parsePublicHttpsUrl(new URL(location, url).toString());
      continue;
    }
    return res;
  }
}
