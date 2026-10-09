import { z } from "zod";

import type { ContactView, ConversationView, FlowDeps, RunRecord } from "@/lib/flow-engine/deps";
import { interpolate, type InterpolateScope } from "@/lib/flow-engine/interpolate";
import type { FlowNode, Outcome } from "@/lib/flow-engine/types";
import { serviceWindow } from "@/lib/whatsapp/window";

export type ExecCtx = {
  run: RunRecord;
  node: FlowNode;
  deps: FlowDeps;
  contact: ContactView | null;
  conversation: ConversationView | null;
  scope: InterpolateScope;
};

export type Executor = (ctx: ExecCtx) => Promise<Outcome>;

export function fail(error: string): Outcome {
  return { kind: "fail", error };
}

/** Parse node.data with a schema; a bad config fails the step instead of throwing. */
export function parseConfig<T extends z.ZodTypeAny>(
  ctx: ExecCtx,
  schema: T,
): { ok: true; data: z.infer<T> } | { ok: false; outcome: Outcome } {
  const r = schema.safeParse(ctx.node.data);
  if (r.success) return { ok: true, data: r.data };
  const first = r.error.issues[0];
  return { ok: false, outcome: fail(`Invalid ${ctx.node.type} settings: ${first?.path.join(".") || "node"} ${first?.message ?? ""}`.trim()) };
}

export function text(ctx: ExecCtx, input: string): string {
  return interpolate(input, ctx.scope, { timezone: ctx.deps.timezone }).text;
}

/** Free-form messages need an open 24h window; otherwise a Template node is required. */
export function freeFormBlocked(ctx: ExecCtx): string | null {
  if (!ctx.conversation) return "This step needs a conversation";
  const w = serviceWindow({
    lastInboundAt: ctx.conversation.last_inbound_at,
    adOpenedAt: ctx.conversation.ad_referral ? ctx.conversation.opened_at : null,
    now: ctx.deps.now(),
  });
  return w.open ? null : "The 24-hour window is closed: use a Template node to reach this patient";
}
