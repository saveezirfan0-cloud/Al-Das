import { widgetPoll, widgetPost, widgetPreflight } from "@/lib/channels/web/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Website chat widget messages (Phase 20e). POST: a visitor's message (the first one creates the visitor token, returned once).
 * GET: the visitor's own conversation, authorised by that token (Authorization: Bearer). Public: allowed websites only, integration
 * on, not a training workspace, rate limited per IP and per visitor. See lib/channels/web/server.ts.
 */
export async function GET(request: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  return widgetPoll(request, key);
}

export async function POST(request: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  return widgetPost(request, key);
}

export async function OPTIONS(request: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  return widgetPreflight(request, key);
}
