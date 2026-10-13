import { z } from "zod";

import {
  fail,
  freeFormBlocked,
  parseConfig,
  text,
  type ExecCtx,
  type Executor,
} from "@/lib/flow-engine/executors/common";
import { ANSWER_TYPES, patternProblem } from "@/lib/flow-engine/node-options";
import type { Outcome } from "@/lib/flow-engine/types";
import { isTemplateSendable } from "@/lib/whatsapp/templates";
import type { InteractiveObject } from "@/lib/whatsapp/types";

const optionSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(24),
});

export const messageSchema = z.object({
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

/**
 * Contact fields a question may save its answer to. The phone number is the patient's identity and gender has a fixed list,
 * so neither is offered; the e-mail field only takes an answer checked as an e-mail.
 */
export const QUESTION_SAVE_FIELD =
  /^(first_name|last_name|email|language|label|custom\.[A-Za-z][A-Za-z0-9_]{0,63})$/;

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
    /** Free-text questions: what counts as a valid answer (lib/flow-engine/answers.ts). Choice questions match an option. */
    answer_type: z.enum(ANSWER_TYPES).default("text"),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    pattern: z.string().max(200).optional(),
    /** How many times to ask again after an answer that does not fit, before the fallback output. 0 = straight to fallback. */
    reask_max: z.number().int().min(0).max(5).default(0),
    reask_text: z.string().max(1024).optional(),
    /** Also save the accepted answer to this contact field. */
    save_to: z.string().regex(QUESTION_SAVE_FIELD, "unsupported field").optional(),
  })
  .superRefine((v, c) => {
    if (v.style === "text" && v.answer_type === "regex") {
      const problem = patternProblem(v.pattern ?? "");
      if (problem) c.addIssue({ code: "custom", path: ["pattern"], message: problem });
    }
    if (v.min !== undefined && v.max !== undefined && v.min > v.max) {
      c.addIssue({ code: "custom", path: ["min"], message: "minimum is above the maximum" });
    }
    if (v.save_to === "email" && !(v.style === "text" && v.answer_type === "email")) {
      c.addIssue({
        code: "custom",
        path: ["save_to"],
        message: "only an e-mail answer can be saved to the e-mail field",
      });
    }
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
  // After an answer it could not accept the run comes back here (one step per re-ask); the re-ask wording replaces the question.
  const asked = ctx.run.context.asks?.[ctx.node.id] ?? 0;
  const wording = asked > 0 && c.reask_text?.trim() ? c.reask_text : c.text;
  const body = text(ctx, wording).trim();
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
    output: { message_id: sent.messageId, ...(asked > 0 ? { reask: asked } : {}) },
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

export const quickReplySchema = z.object({
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

export const templateSchema = z.object({
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
