import { widgetConfig, widgetPreflight } from "@/lib/channels/web/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Website chat widget settings (Phase 20e): title, colour and welcome text only. Public: answered only for an allowed website
 * (Origin), while the integration is on and outside training workspaces; rate limited per IP. See lib/channels/web/server.ts.
 */
export async function GET(request: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  return widgetConfig(request, key);
}

export async function OPTIONS(request: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  return widgetPreflight(request, key);
}
