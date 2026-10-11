import { z } from "zod";

import {
  fail,
  parseConfig,
  text,
  type ExecCtx,
  type Executor,
} from "@/lib/flow-engine/executors/common";
import type { Outcome } from "@/lib/flow-engine/types";

/** Phone is the contact's identity (E.164 match key), so flows may not rewrite it. */
const FIELD =
  /^(first_name|last_name|email|gender|language|label|custom\.[A-Za-z][A-Za-z0-9_]{0,63})$/;

const updateFieldSchema = z.object({
  field: z.string().regex(FIELD, "unsupported field"),
  value: z.string().max(1000),
});

export const update_contact_field: Executor = async (ctx) => {
  const cfg = parseConfig(ctx, updateFieldSchema);
  if (!cfg.ok) return cfg.outcome;
  if (!ctx.contact) return fail("This step needs a contact");
  const value = text(ctx, cfg.data.value).trim();
  if (cfg.data.field === "gender" && !["female", "male", "other", "unknown"].includes(value)) {
    return fail("Gender must be female, male, other or unknown");
  }
  if (cfg.data.field === "email" && value !== "" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
    return fail("That is not a valid email address");
  }
  await ctx.deps.actions.updateContactField(ctx.run, cfg.data.field, value);
  return { kind: "next", output: { field: cfg.data.field } };
};

type PortMethod = "createEnquiry" | "addTask" | "upsertPortalRecord" | "bookAppointment";

/** CRM nodes call a port; until the module's phase registers an adapter the step fails closed with a clear reason. */
function portNode(
  method: PortMethod,
  label: string,
  schema: z.ZodType<Record<string, unknown>>,
): Executor {
  return async (ctx: ExecCtx): Promise<Outcome> => {
    const cfg = parseConfig(ctx, schema);
    if (!cfg.ok) return cfg.outcome;
    const fn = ctx.deps.crm[method];
    if (!fn) return fail(`${label} is not available yet (module not installed)`);
    // Interpolate every string value one level deep.
    const input: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cfg.data))
      input[k] = typeof v === "string" ? text(ctx, v) : v;
    const created = await fn.call(ctx.deps.crm, ctx.run, input);
    return { kind: "next", output: { id: created.id } };
  };
}

const loose = z.record(z.string(), z.unknown());
export const create_enquiry = portNode("createEnquiry", "Create enquiry", loose);
export const add_task = portNode("addTask", "Add task", loose);
export const portal_record = portNode("upsertPortalRecord", "Portal record", loose);
export const book_appointment = portNode("bookAppointment", "Book appointment", loose);
