import { z } from "zod";

import { fail, parseConfig, text, type Executor } from "@/lib/flow-engine/executors/common";
import { META_EVENT_NAMES } from "@/lib/flow-engine/node-options";
import { checkOutboundUrl } from "@/lib/flow-engine/ssrf";

export const apiSchema = z.object({
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

export const notifySchema = z.object({
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

// ---------------------------------------------------------------------------
// Phase 20b: payment links (Phase 19a) and Conversions API events (Phase 19b). Both wrap the existing integration code,
// which does every check itself (switched on, not a training workspace, template approved, consent, …); the node only
// passes ids and plain values. Outputs carry ids and statuses, never a link, amount or name.
// ---------------------------------------------------------------------------

export const paymentLinkSchema = z.object({
  /** The finance invoice number, usually a {variable}. The invoice's patient must be this run's contact. */
  invoice_number: z.string().trim().min(1).max(100),
  /** Plain decimal in the integration's currency, e.g. 150.00 or {vars.amount}; never more than the invoice total. */
  amount: z.string().trim().min(1).max(30),
});

export const payment_link: Executor = async (ctx) => {
  const cfg = parseConfig(ctx, paymentLinkSchema);
  if (!cfg.ok) return cfg.outcome;
  const port = ctx.deps.crm.createPaymentLink;
  if (!port) return fail("Payment links are not available in this workspace");
  if (!ctx.contact) return fail("This step needs a contact");
  const res = await port.call(ctx.deps.crm, ctx.run, {
    invoice_number: text(ctx, cfg.data.invoice_number).trim().slice(0, 100),
    amount: text(ctx, cfg.data.amount).trim().slice(0, 30),
  });
  if (!res.ok) return fail(res.error);
  return { kind: "next", output: { request_id: res.requestId } };
};

export const metaEventSchema = z.object({ event_name: z.enum(META_EVENT_NAMES) });

/** queueCapiEvent outcomes that mean "this workspace cannot send it": the step fails (error output). */
const META_EVENT_REFUSED: Record<string, string> = {
  off: "Meta ad attribution is switched off",
  training: "This is a training workspace: no ad events are sent",
};

export const meta_event: Executor = async (ctx) => {
  const cfg = parseConfig(ctx, metaEventSchema);
  if (!cfg.ok) return cfg.outcome;
  const port = ctx.deps.crm.sendMetaEvent;
  if (!port) return fail("Meta ad events are not available in this workspace");
  if (!ctx.contact) return fail("This step needs a contact");
  const res = await port.call(ctx.deps.crm, ctx.run, { event_name: cfg.data.event_name });
  const refused = META_EVENT_REFUSED[res.status];
  if (refused) return fail(refused);
  // queued, duplicate, report_only, no_ad_click and skipped:<consent / window / age> are normal outcomes, not errors.
  return { kind: "next", output: { event: cfg.data.event_name, status: res.status } };
};
