import { z } from "zod";

import { fail, parseConfig, text, type Executor } from "@/lib/flow-engine/executors/common";

const assignSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), id: z.string().uuid() }),
  z.object({ type: z.literal("team"), id: z.string().uuid() }),
  z.object({ type: z.literal("bot") }),
  z.object({ type: z.literal("unassign") }),
]);

export const assign_to: Executor = async (ctx) => {
  const cfg = parseConfig(ctx, z.object({ target: assignSchema }));
  if (!cfg.ok) return cfg.outcome;
  if (!ctx.conversation) return fail("This step needs a conversation");
  const t = cfg.data.target;
  await ctx.deps.actions.assign(ctx.run, t.type === "user" || t.type === "team" ? { type: t.type, id: t.id } : { type: t.type });
  // Handing to a human ends the bot's turn: the flow stops here (human takeover).
  if (t.type === "user" || t.type === "team") return { kind: "end", status: "completed", output: { assigned_to: t.type } };
  return { kind: "next", output: { assigned_to: t.type } };
};

export const close_conversation: Executor = async (ctx) => {
  if (!ctx.conversation) return fail("This step needs a conversation");
  await ctx.deps.actions.closeConversation(ctx.run);
  // The conversation is closed; nothing further can be sent in it.
  return { kind: "end", status: "completed", output: { closed: true } };
};

export const add_comment: Executor = async (ctx) => {
  const cfg = parseConfig(ctx, z.object({ text: z.string().min(1).max(4000) }));
  if (!cfg.ok) return cfg.outcome;
  if (!ctx.conversation) return fail("This step needs a conversation");
  const body = text(ctx, cfg.data.text).trim();
  if (!body) return fail("Comment is empty after filling in variables");
  await ctx.deps.actions.addComment(ctx.run, body);
  return { kind: "next" };
};
