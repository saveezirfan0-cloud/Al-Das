"use server";

import { z } from "zod";

import { requireMember } from "@/lib/auth/session";
import { checkRateLimit, RATE_RULES } from "@/lib/rate-limit";
import { redactText } from "@/lib/redact";
import { createAdminClient } from "@/lib/supabase/admin";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const schema = z.object({
  /** The path the person was on; query strings and ids are cut off. */
  page: z
    .string()
    .trim()
    .max(200)
    .transform((p) =>
      p
        .split("?")[0]
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id"),
    ),
  kind: z.enum(["idea", "problem", "question", "praise"]),
  message: z.string().trim().min(3, "Write a few words first.").max(2000),
});

/**
 * The Feedback button. Anyone signed in may send it; the row names the sender and the page, never a patient. The
 * text is free-form, so it is stored as typed but redacted before it reaches any log line.
 */
export async function submitFeedback(input: z.input<typeof schema>): Promise<ActionResult> {
  const member = await requireMember();
  const p = schema.safeParse(input);
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "Check the feedback." };
  const admin = createAdminClient();
  const limited = await checkRateLimit(
    admin,
    "help-feedback",
    member.userId,
    RATE_RULES.helpFeedbackPerUser,
  );
  if (!limited.allowed)
    return { ok: false, error: "That is a lot of feedback. Try again in a while." };
  const { error } = await admin.from("help_feedback").insert({
    org_id: member.orgId,
    user_id: member.userId,
    page: p.data.page || "/",
    kind: p.data.kind,
    message: p.data.message,
  });
  if (error) {
    console.error("[help] feedback insert failed", redactText(error.message, 120));
    return { ok: false, error: "Could not send your feedback." };
  }
  return { ok: true, message: "Thank you. Your feedback was sent to the administrators." };
}
