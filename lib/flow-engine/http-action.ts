import "server-only";

import { lookup } from "node:dns/promises";

import { checkOutboundUrl, isPrivateAddress } from "@/lib/flow-engine/ssrf";

const MAX_BODY_BYTES = 100_000;

/** Outbound HTTP for the API Action node: https only, DNS re-checked, no redirects, bounded body. */
export async function guardedHttp(req: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}): Promise<{ status: number; body: unknown }> {
  const check = checkOutboundUrl(req.url);
  if (!check.ok) throw new Error(check.reason);
  const addrs = await lookup(check.url.hostname, { all: true });
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error("Host resolves to a private address");
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), req.timeoutMs);
  try {
    const res = await fetch(check.url, {
      method: req.method,
      headers: req.headers,
      body: req.method === "GET" ? undefined : req.body,
      redirect: "manual",
      signal: ctl.signal,
    });
    const reader = res.body?.getReader();
    let received = 0;
    const chunks: Uint8Array[] = [];
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_BODY_BYTES) {
        ctl.abort();
        break;
      }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    let body: unknown = text;
    if ((res.headers.get("content-type") ?? "").includes("json")) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}
