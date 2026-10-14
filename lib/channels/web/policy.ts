import { createHash, randomBytes } from "node:crypto";

import type { RateRule } from "@/lib/rate-limit";

/**
 * Website chat widget decisions (pure, Phase 20e). The routes in app/api/widget/[key]/* call these and nothing else decides
 * who may talk to the widget.
 *
 *   - The widget only answers browsers on the domains an administrator listed (the Origin header, https only). A script
 *     outside a browser can fake an Origin, so the per-IP and per-session limits below are what stop abuse.
 *   - A visitor is a random 256-bit token the widget keeps in localStorage (no cookie). Pulse stores only its SHA-256 and
 *     creates the token itself on the visitor's first message; it is the only thing that can read that visitor's chat.
 */

const HOST_RE = /^(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Splits the "Allowed websites" setting into normalised host names. Returns null when any entry is not a host name. */
export function parseAllowedDomains(text: unknown): string[] | null {
  if (typeof text !== "string") return null;
  const parts = text
    .split(/[\s,;]+/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0 || parts.length > 20) return null;
  const out: string[] = [];
  for (const raw of parts) {
    let host = raw;
    if (/^https?:\/\//.test(host)) {
      try {
        const u = new URL(host);
        if (u.port || u.username || u.password || (u.pathname !== "/" && u.pathname !== ""))
          return null;
        host = u.hostname;
      } catch {
        return null;
      }
    }
    host = host.replace(/\.$/, "");
    if (!HOST_RE.test(host) || host.length > 253) return null;
    if (!out.includes(host)) out.push(host);
  }
  return out;
}

/** Is this Origin header one of the allowed websites? https only; "*.example.com" matches sub-domains, not example.com itself. */
export function originAllowed(
  origin: string | null | undefined,
  allowed: readonly string[],
): boolean {
  if (!origin || allowed.length === 0) return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  if (u.port && u.port !== "443") return false;
  const host = u.hostname.toLowerCase();
  return allowed.some((a) =>
    a.startsWith("*.") ? host.endsWith(a.slice(1)) && host.length > a.length - 1 : host === a,
  );
}

/** A new visitor token (43 url-safe characters, 256 bits) and the hash that is stored. */
export function newVisitorToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashVisitorToken(token) };
}

export function hashVisitorToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Reads "Authorization: Bearer <token>"; anything that is not exactly a token we could have issued is ignored. */
export function bearerToken(header: string | null | undefined): string | null {
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec((header ?? "").trim());
  return m ? m[1] : null;
}

export const MAX_WIDGET_MESSAGE = 2000;
export const MAX_VISITOR_NAME = 60;

export type VisitorMessage = { text: string; clientId: string; name: string | null };

/** Validates what the widget posts. Control characters other than new lines and tabs are refused. */
export function parseVisitorMessage(
  input: unknown,
): { ok: true; value: VisitorMessage } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { ok: false, error: "invalid" };
  const o = input as Record<string, unknown>;
  const text = typeof o.text === "string" ? o.text.replace(/\r\n?/g, "\n").trim() : "";
  if (!text) return { ok: false, error: "empty" };
  if (text.length > MAX_WIDGET_MESSAGE) return { ok: false, error: "too_long" };
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) return { ok: false, error: "invalid" };
  const clientId = typeof o.client_id === "string" ? o.client_id : "";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) return { ok: false, error: "invalid" };
  let name: string | null = null;
  if (o.name !== undefined && o.name !== null && o.name !== "") {
    if (typeof o.name !== "string") return { ok: false, error: "invalid" };
    const n = o.name.trim().replace(/\s+/g, " ");
    if (n.length > MAX_VISITOR_NAME || /[\u0000-\u001f\u007f<>]/.test(n))
      return { ok: false, error: "invalid" };
    name = n || null;
  }
  return { ok: true, value: { text, clientId, name } };
}

/** `after` cursor of a poll: an ISO time no more than a year old, else null (= from the session's start). */
export function parseAfter(value: string | null, now: Date = new Date()): string | null {
  if (!value || value.length > 40) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t) || t > now.getTime() + 60_000 || t < now.getTime() - 366 * 86_400_000)
    return null;
  return new Date(t).toISOString();
}

/**
 * Rate limits of the public widget routes (lib/rate-limit.ts counts them in Postgres). Every request counts. Widget polls
 * every 5 seconds while open and every 30 seconds otherwise, well under the poll limits.
 */
export const WIDGET_RATE_RULES = {
  /** Loading the widget's settings, per IP. */
  configPerIp: { limit: 60, windowSec: 60, failOpen: true },
  /** Messages sent, per IP (an office behind one address may have several visitors). */
  sendPerIp: { limit: 30, windowSec: 60, failOpen: false },
  /** Messages sent, per visitor. */
  sendPerSession: { limit: 10, windowSec: 60, failOpen: false },
  /** New visitors (first messages), per IP and hour. */
  newSessionPerIp: { limit: 10, windowSec: 3600, failOpen: false },
  /** Polls for replies, per IP. */
  pollPerIp: { limit: 240, windowSec: 60, failOpen: true },
  /** Polls for replies, per visitor. */
  pollPerSession: { limit: 30, windowSec: 60, failOpen: true },
  /** Requests for an unknown or switched-off widget, or from a website not on the list, per IP. */
  refusedPerIp: { limit: 30, windowSec: 60, failOpen: true },
} as const satisfies Record<string, RateRule>;

export type WidgetDisplay = { title: string; colour: string; welcome: string };

export const WIDGET_DEFAULTS: WidgetDisplay = {
  title: "Chat with us",
  colour: "#0f766e",
  welcome:
    "Hello! How can we help you today? Please do not share medical emergencies here: call your local emergency number.",
};

/** What the widget may show, from the integration's settings (never anything else from the account). */
export function widgetDisplay(config: Record<string, unknown>): WidgetDisplay {
  const str = (v: unknown, max: number) =>
    typeof v === "string" && v.trim() && v.length <= max && !/[\u0000-\u001f<>]/.test(v)
      ? v.trim()
      : null;
  const colour =
    typeof config.colour === "string" && /^#[0-9a-fA-F]{6}$/.test(config.colour)
      ? config.colour.toLowerCase()
      : WIDGET_DEFAULTS.colour;
  return {
    title: str(config.title, 40) ?? WIDGET_DEFAULTS.title,
    colour,
    welcome: str(config.welcome, 300) ?? WIDGET_DEFAULTS.welcome,
  };
}

export type WidgetGate =
  { ok: true } | { ok: false; status: 404 | 403; reason: "not_found" | "origin" };

/**
 * Whether a widget request may proceed: the integration exists and is on, the workspace is not a training workspace, and
 * the request comes from an allowed website. Unknown, switched-off and training all answer the same 404.
 */
export function widgetGate(a: {
  exists: boolean;
  enabled: boolean;
  training: boolean;
  origin: string | null;
  allowedDomains: readonly string[] | null;
}): WidgetGate {
  if (!a.exists || !a.enabled || a.training) return { ok: false, status: 404, reason: "not_found" };
  if (!a.allowedDomains || !originAllowed(a.origin, a.allowedDomains))
    return { ok: false, status: 403, reason: "origin" };
  return { ok: true };
}

/** CORS headers for an allowed origin (never "*", never credentials). */
export function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}
