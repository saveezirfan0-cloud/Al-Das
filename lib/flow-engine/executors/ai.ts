import { z } from "zod";

import { detectEmergency } from "@/lib/ai/intent/emergency";
import { fail, parseConfig, type Executor } from "@/lib/flow-engine/executors/common";
import { ROUTABLE_INTENTS } from "@/lib/flow-engine/node-options";

/**
 * AI router (Phase 20b, G3). DRAFT-SAFE by construction:
 *  - it reads the newest inbound message and asks the EXISTING intent pipeline (lib/ai/intent, a closed enum) for labels;
 *  - it only chooses an output: it never writes, sends or stores model text (its output is one label or none);
 *  - emergency wording is checked first, deterministically and with AI off; an emergency stops the run (a person handles it,
 *    the inbound screening has already escalated it) and is never routed;
 *  - AI off, no provider, the daily cap, an error or no label all take the Else output.
 */
export const aiRouterSchema = z.object({
  /** One output per label, in priority order (the first label the message carries wins). */
  intents: z
    .array(z.enum(ROUTABLE_INTENTS as [string, ...string[]]))
    .min(1)
    .max(ROUTABLE_INTENTS.length)
    .refine((a) => new Set(a).size === a.length, "each label can only have one output"),
});

export const ai_router: Executor = async (ctx) => {
  const cfg = parseConfig(ctx, aiRouterSchema);
  if (!cfg.ok) return cfg.outcome;
  if (!ctx.conversation) return fail("This step needs a conversation");
  const crm = ctx.deps.crm;
  const last = crm.lastInbound ? await crm.lastInbound.call(crm, ctx.run) : null;
  if (!last) return { kind: "next", handle: "else", output: { intent: null, ai: "no_message" } };
  if (detectEmergency(last.body).matched) {
    return { kind: "end", status: "cancelled", output: { emergency: true } };
  }
  let labels: string[] | null = null;
  if (crm.intentsFor) {
    try {
      labels = await crm.intentsFor.call(crm, ctx.run, last.messageId);
    } catch {
      labels = null; // a provider problem never fails the flow: Else
    }
  }
  if (labels?.includes("emergency")) {
    return { kind: "end", status: "cancelled", output: { emergency: true } };
  }
  if (!labels) return { kind: "next", handle: "else", output: { intent: null, ai: "off" } };
  const hit = cfg.data.intents.find((i) => labels.includes(i));
  return hit
    ? { kind: "next", handle: `intent:${hit}`, output: { intent: hit, ai: "on" } }
    : { kind: "next", handle: "else", output: { intent: null, ai: "on" } };
};
