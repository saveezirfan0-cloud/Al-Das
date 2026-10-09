import { z } from "zod";

import { fail, parseConfig, text, type Executor } from "@/lib/flow-engine/executors/common";
import { checkOutboundUrl } from "@/lib/flow-engine/ssrf";

const apiSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  url: z.string().min(1).max(2000),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().max(20000).optional(),
  timeout_seconds: z.number().int().min(1).max(30).default(10),
});

export const api_action: Executor = async (ctx) => {
  const cfg = parseConfig(ctx, apiSchema);
  if (!cfg.ok) return cfg.outcome;
  const url = text(ctx, cfg.data.url).trim();
  const check = checkOutboundUrl(url);
  if (!check.ok) return fail(check.reason);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg.data.headers)) headers[k] = text(ctx, v);
  const res = await ctx.deps.actions.http({
    method: cfg.data.method,
    url: check.url.toString(),
    headers,
    body: cfg.data.body === undefined ? undefined : text(ctx, cfg.data.body),
    timeoutMs: cfg.data.timeout_seconds * 1000,
  });
  const ok = res.status >= 200 && res.status < 300;
  // Response body is kept for {steps.<node>.response.x}; headers and request body are never stored.
  const output = {
    status: res.status,
    ...(typeof res.body === "object" && res.body !== null
      ? (res.body as Record<string, unknown>)
      : { body: res.body }),
  };
  return ok ? { kind: "next", output } : { kind: "fail", error: `HTTP ${res.status}`, output };
};

const notifySchema = z.object({
  target: z.discriminatedUnion("type", [
    z.object({ type: z.literal("user"), id: z.string().uuid() }),
    z.object({ type: z.literal("team"), id: z.string().uuid() }),
    z.object({ type: z.literal("role"), id: z.string().min(1) }),
  ]),
  title: z.string().min(1).max(120),
  body: z.string().max(500).default(""),
});

export const send_notification: Executor = async (ctx) => {
  const cfg = parseConfig(ctx, notifySchema);
  if (!cfg.ok) return cfg.outcome;
  const sent = await ctx.deps.actions.notify(
    ctx.run,
    cfg.data.target,
    text(ctx, cfg.data.title),
    text(ctx, cfg.data.body),
  );
  return { kind: "next", output: { notified: sent } };
};
