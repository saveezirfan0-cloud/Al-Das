import { z } from "zod";

import {
  fail,
  freeFormBlocked,
  parseConfig,
  text,
  type ExecCtx,
  type Executor,
} from "@/lib/flow-engine/executors/common";
import type { Outcome } from "@/lib/flow-engine/types";
import { isTemplateSendable } from "@/lib/whatsapp/templates";
import type { InteractiveObject } from "@/lib/whatsapp/types";

const optionSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(24),
});

const messageSchema = z.object({
  text: z.string().min(1).max(4096),
});

export const message: Executor = async (ctx) => {
  const cfg = parseConfig(ctx, messageSchema);
  if (!cfg.ok) return cfg.outcome;
  const blocked = freeFormBlocked(ctx);
  if (blocked) return fail(blocked);
  const body = text(ctx, cfg.data.text).trim();
  if (!body) return fail("Message is empty after filling in variables");
  const sent = await ctx.deps.actions.send(ctx.run, { type: "text", body }, body);
  return { kind: "next", output: { message_id: sent.messageId } };
};

export const questionSchema = z
  .object({
    text: z.string().min(1).max(1024),
    style: z.enum(["buttons", "list", "text"]).default("text"),
    options: z.array(optionSchema).max(10).default([]),
    list_button_label: z.string().min(1).max(20).default("Choose"),
    variable: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
      .optional(),
    timeout_seconds: z
      .number()
      .int()
      .min(30)
      .max(60 * 60 * 24 * 30)
      .optional(),
  })
  .superRefine((v, c) => {
    if (v.style === "buttons" && (v.options.length < 1 || v.options.length > 3)) {
      c.addIssue({ code: "custom", path: ["options"], message: "buttons need 1–3 options" });
    }
    if (v.style === "list" && (v.options.length < 1 || v.options.length > 10)) {
      c.addIssue({ code: "custom", path: ["options"], message: "lists need 1–10 rows" });
    }
    if (new Set(v.options.map((o) => o.id)).size !== v.options.length) {
      c.addIssue({ code: "custom", path: ["options"], message: "option ids must be unique" });
    }
  });

function interactiveFor(
  style: "buttons" | "list",
  body: string,
  options: Array<{ id: string; title: string }>,
  listLabel: string,
): InteractiveObject {
  if (style === "buttons") {
    return {
      type: "button",
      body: { text: body },
      action: {
        buttons: options.map((o) => ({
          type: "reply" as const,
          reply: { id: o.id, title: o.title },
        })),
      },
    };
  }
  return {
    type: "list",
    body: { text: body },
    action: {
      button: listLabel,
      sections: [{ rows: options.map((o) => ({ id: o.id, title: o.title })) }],
    },
  };
}

export const question: Executor = async (ctx) => {
  const cfg = parseConfig(ctx, questionSchema);
  if (!cfg.ok) return cfg.outcome;
  const c = cfg.data;
  const blocked = freeFormBlocked(ctx);
  if (blocked) return fail(blocked);
  const body = text(ctx, c.text).trim();
  if (!body) return fail("Question is empty after filling in variables");

  const options = c.style === "text" ? [] : c.options;
  const sent =
    c.style === "text"
      ? await ctx.deps.actions.send(ctx.run, { type: "text", body }, body)
      : await ctx.deps.actions.send(
          ctx.run,
          {
            type: "interactive",
            interactive: interactiveFor(c.style, body, options, c.list_button_label),
          },
          body,
        );

  const token = ctx.deps.uuid();
  const timeoutAt = c.timeout_seconds
    ? new Date(ctx.deps.now().getTime() + c.timeout_seconds * 1000)
    : null;
  if (timeoutAt) {
    await ctx.deps.jobs.scheduleResume({
      orgId: ctx.run.org_id,
      runId: ctx.run.id,
      token,
      runAt: timeoutAt,
    });
  }
  return {
    kind: "wait",
    output: { message_id: sent.messageId },
    waiting: {
      kind: "reply",
      token,
      node_id: ctx.node.id,
      options,
      variable: c.variable,
      timeout_at: timeoutAt?.toISOString(),
    },
  };
};

const quickReplySchema = z.object({
  text: z.string().min(1).max(1024),
  buttons: z.array(optionSchema).min(1).max(3),
});

/** Sends a message with up to 3 quick-reply buttons and continues; the patient's tap arrives as a normal inbound message. */
export const quick_reply: Executor = async (ctx) => {
  const cfg = parseConfig(ctx, quickReplySchema);
  if (!cfg.ok) return cfg.outcome;
  const blocked = freeFormBlocked(ctx);
  if (blocked) return fail(blocked);
  const body = text(ctx, cfg.data.text).trim();
  if (!body) return fail("Message is empty after filling in variables");
  const sent = await ctx.deps.actions.send(
    ctx.run,
    {
      type: "interactive",
      interactive: interactiveFor("buttons", body, cfg.data.buttons, "Choose"),
    },
    body,
  );
  return { kind: "next", output: { message_id: sent.messageId } };
};

const templateSchema = z.object({
  template_id: z.string().uuid(),
  /** key (e.g. body.1) → text with {variables}; falls back to the template's own variable_map. */
  values: z.record(z.string(), z.string()).default({}),
});

export function marketingBlocked(
  category: string,
  contact: { stop_marketing: boolean; promotions_opt_in: boolean },
): string | null {
  if (category.toUpperCase() !== "MARKETING") return null;
  if (contact.stop_marketing) return "Patient has stopped marketing messages";
  if (!contact.promotions_opt_in) return "Patient has not opted in to marketing messages";
  return null;
}

export const template: Executor = async (ctx: ExecCtx): Promise<Outcome> => {
  const cfg = parseConfig(ctx, templateSchema);
  if (!cfg.ok) return cfg.outcome;
  if (!ctx.contact) return fail("This step needs a contact");
  const tpl = await ctx.deps.store.getTemplate(ctx.run.org_id, cfg.data.template_id);
  if (!tpl) return fail("Template not found");
  if (!isTemplateSendable(tpl.status)) return fail(`Template is ${tpl.status}, not approved`);
  if (ctx.contact.stop_marketing && tpl.category.toUpperCase() === "MARKETING") {
    return fail("Patient has stopped marketing messages");
  }
  const blockedByOptIn = marketingBlocked(tpl.category, ctx.contact);
  if (blockedByOptIn) return fail(blockedByOptIn);

  const values: Record<string, string> = {};
  const source = { ...tpl.variable_map, ...cfg.data.values };
  for (const [key, expr] of Object.entries(source)) {
    // variable_map entries are bare paths ("contact.first_name"); node overrides may be free text.
    values[key] = text(ctx, expr.includes("{") ? expr : `{${expr}}`).trim();
  }
  const sent = await ctx.deps.actions.send(
    ctx.run,
    { type: "template", template_id: tpl.id, values },
    null,
  );
  return { kind: "next", output: { message_id: sent.messageId, template: tpl.name } };
};
