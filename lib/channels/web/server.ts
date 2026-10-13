import "server-only";

import { NextResponse } from "next/server";

import { ensureChannel } from "@/lib/channels/ensure";
import { afterChannelInbound, readReceiveResult } from "@/lib/channels/inbound";
import { loadAccountById, readConfig } from "@/lib/integrations/accounts";
import { checkRateLimit, clientIp, type RateRule } from "@/lib/rate-limit";
import { redactText } from "@/lib/redact";
import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";
import { isTrainingOrg } from "@/lib/training/mode";

import {
  bearerToken,
  corsHeaders,
  hashVisitorToken,
  newVisitorToken,
  parseAfter,
  parseAllowedDomains,
  parseVisitorMessage,
  WIDGET_RATE_RULES,
  widgetDisplay,
  widgetGate,
} from "./policy";

/**
 * The public website chat routes (app/api/widget/[key]/*). No sign-in: each request passes widgetGate() (switch on, not a
 * training workspace, an allowed website), the rate limits in WIDGET_RATE_RULES, and, for anything that reads a chat, the
 * visitor's own token. Answers never carry a name, number, staff member or note, and nothing is cached.
 */

export type WidgetDeps = { admin?: AdminClient; now?: () => Date };

const MAX_BODY_BYTES = 8_192;
const POLL_LIMIT = 50;

type Widget = { id: string; orgId: string; config: Record<string, unknown> };

type Ctx = {
  admin: AdminClient;
  ip: string;
  origin: string | null;
  widget: Widget | null;
  cors: Record<string, string>;
};

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

async function limited(
  admin: AdminClient,
  scope: string,
  id: string,
  rule: RateRule,
  cors: Record<string, string>,
) {
  const r = await checkRateLimit(admin, scope, id, rule);
  if (r.allowed) return null;
  return json({ error: "rate_limited", retry_after: r.retryAfter }, 429, {
    ...cors,
    "Retry-After": String(Math.max(1, r.retryAfter)),
  });
}

/** Loads the widget behind `key` and applies the gate. Returns the refusal to send, or the context to carry on with. */
async function open(request: Request, key: string, deps: WidgetDeps): Promise<Ctx | Response> {
  const admin = deps.admin ?? createAdminClient();
  const ip = clientIp(request.headers);
  const origin = request.headers.get("origin");
  const row = await loadAccountById(admin, key, "web_chat");
  const config = row ? readConfig(row) : {};
  const gate = widgetGate({
    exists: !!row,
    enabled: row?.enabled === true,
    training: row ? await isTrainingOrg(admin, row.org_id) : false,
    origin,
    allowedDomains: parseAllowedDomains(config.allowed_domains),
  });
  if (!gate.ok || !row || !origin) {
    const refused = await limited(admin, "widget-refused", ip, WIDGET_RATE_RULES.refusedPerIp, {});
    if (refused) return refused;
    return json({ error: gate.ok ? "not_found" : gate.reason }, gate.ok ? 404 : gate.status);
  }
  return {
    admin,
    ip,
    origin,
    widget: { id: row.id, orgId: row.org_id, config },
    cors: corsHeaders(origin),
  };
}

/** OPTIONS: the browser's pre-flight for the POST and the Authorization header. */
export async function widgetPreflight(request: Request, key: string, deps: WidgetDeps = {}) {
  const ctx = await open(request, key, deps);
  if (ctx instanceof Response) return ctx;
  return new Response(null, { status: 204, headers: ctx.cors });
}

/** GET config: the title, colour and welcome text an administrator chose. */
export async function widgetConfig(request: Request, key: string, deps: WidgetDeps = {}) {
  const ctx = await open(request, key, deps);
  if (ctx instanceof Response) return ctx;
  const stop = await limited(
    ctx.admin,
    "widget-config",
    ctx.ip,
    WIDGET_RATE_RULES.configPerIp,
    ctx.cors,
  );
  if (stop) return stop;
  return json(widgetDisplay(ctx.widget!.config), 200, ctx.cors);
}

/**
 * POST messages: a visitor's message. Without a token this is the visitor's first message: Pulse creates the token, the contact
 * (no phone, source "web_chat") and the conversation, and returns the token ONCE for the widget to keep in localStorage.
 */
export async function widgetPost(request: Request, key: string, deps: WidgetDeps = {}) {
  const ctx = await open(request, key, deps);
  if (ctx instanceof Response) return ctx;
  const { admin, ip, cors } = ctx;
  const widget = ctx.widget!;

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return json({ error: "too_large" }, 413, cors);
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return json({ error: "too_large" }, 413, cors);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid" }, 400, cors);
  }
  const parsed = parseVisitorMessage(body);
  if (!parsed.ok) return json({ error: parsed.error }, 400, cors);

  const token = bearerToken(request.headers.get("authorization"));
  const stopIp = await limited(admin, "widget-send-ip", ip, WIDGET_RATE_RULES.sendPerIp, cors);
  if (stopIp) return stopIp;
  const fresh = token ? null : newVisitorToken();
  const hash = token ? hashVisitorToken(token) : fresh!.hash;
  const stopVisitor = token
    ? await limited(admin, "widget-send-session", hash, WIDGET_RATE_RULES.sendPerSession, cors)
    : await limited(admin, "widget-new-session", ip, WIDGET_RATE_RULES.newSessionPerIp, cors);
  if (stopVisitor) return stopVisitor;

  const channel = await ensureChannel(admin, {
    orgId: widget.orgId,
    type: "web",
    externalId: widget.orgId,
  });
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const { data, error } = await admin.rpc("web_chat_receive", {
    p_org: widget.orgId,
    p_channel: channel.id,
    p_token_hash: hash,
    p_create: !token,
    p_name: parsed.value.name ?? "",
    p_client_id: parsed.value.clientId,
    p_body: parsed.value.text,
    p_at: at,
  });
  if (error) {
    console.error("[widget] receive failed", {
      code: error.code,
      error: redactText(error.message, 80),
    });
    return json({ error: "unavailable" }, 503, cors);
  }
  const result = readReceiveResult(data);
  if (result.error === "session") return json({ error: "session" }, 401, cors);
  if (result.error) return json({ error: "unavailable" }, 503, cors);
  await afterChannelInbound(admin, {
    orgId: widget.orgId,
    channelType: "web",
    body: parsed.value.text,
    result,
  });
  return json(
    {
      ok: true,
      ...(fresh ? { token: fresh.token } : {}),
      message: { id: result.message_id, at },
    },
    200,
    cors,
  );
}

export type WidgetMessage = { id: string; from: "visitor" | "clinic"; text: string; at: string };

/** GET messages: this visitor's own conversation only (their messages and the clinic's sent replies; never notes). */
export async function widgetPoll(request: Request, key: string, deps: WidgetDeps = {}) {
  const ctx = await open(request, key, deps);
  if (ctx instanceof Response) return ctx;
  const { admin, ip, cors } = ctx;
  const widget = ctx.widget!;
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) return json({ error: "session" }, 401, cors);
  const hash = hashVisitorToken(token);
  const stopIp = await limited(admin, "widget-poll-ip", ip, WIDGET_RATE_RULES.pollPerIp, cors);
  if (stopIp) return stopIp;
  const stopVisitor = await limited(
    admin,
    "widget-poll-session",
    hash,
    WIDGET_RATE_RULES.pollPerSession,
    cors,
  );
  if (stopVisitor) return stopVisitor;

  const { data: session } = await admin
    .from("web_chat_sessions")
    .select("id, org_id, conversation_id, created_at")
    .eq("token_hash", hash)
    .maybeSingle();
  if (!session || session.org_id !== widget.orgId) return json({ error: "session" }, 401, cors);
  if (!session.conversation_id) return json({ messages: [] }, 200, cors);

  const now = (deps.now ?? (() => new Date()))();
  const after = parseAfter(new URL(request.url).searchParams.get("after"), now);
  const from =
    after && Date.parse(after) > Date.parse(session.created_at)
      ? after
      : new Date(session.created_at).toISOString();
  const { data: rows } = await admin
    .from("messages")
    .select("id, direction, body, at, status, kind")
    .eq("org_id", widget.orgId)
    .eq("conversation_id", session.conversation_id)
    .in("direction", ["in", "out"])
    .eq("kind", "text")
    .gte("at", from)
    .order("at", { ascending: true })
    .limit(POLL_LIMIT);
  const messages: WidgetMessage[] = (rows ?? [])
    .filter((m) => m.direction === "in" || ["sent", "delivered", "read"].includes(m.status))
    .map((m) => ({
      id: m.id,
      from: m.direction === "in" ? "visitor" : "clinic",
      text: m.body ?? "",
      at: m.at,
    }));
  const delivered = (rows ?? [])
    .filter((m) => m.direction === "out" && m.status === "sent")
    .map((m) => m.id);
  if (delivered.length)
    await admin
      .from("messages")
      .update({ status: "delivered" })
      .in("id", delivered)
      .eq("status", "sent");
  await admin
    .from("web_chat_sessions")
    .update({ last_seen_at: now.toISOString() })
    .eq("id", session.id);
  return json({ messages }, 200, cors);
}
